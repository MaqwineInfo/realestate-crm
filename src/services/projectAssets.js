const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ProjectAsset, Project } = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const config = require('../config');
const audit = require('./audit');

/**
 * V1.1 §31: project media and documents.
 *
 * MIME type is validated on the server against the *declared* asset type (§31.3).
 * A browser's accept attribute is a hint to the user, not a control — the check
 * that matters is this one.
 *
 * ponytail: local disk under UPLOAD_DIR, served by the existing static handler.
 * Swap `store()` for an object-store put if this ever needs to scale past one box.
 */
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const DOCUMENT_MIME = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const allowedFor = (assetType) => (assetType === 'IMAGE' ? IMAGE_MIME : DOCUMENT_MIME);

function assertAcceptable({ assetType, mimeType, size }) {
  if (!['IMAGE', 'DOCUMENT'].includes(assetType)) throw badRequest('Choose whether this is an image or a document.');
  if (!allowedFor(assetType).includes(mimeType)) {
    throw badRequest(assetType === 'IMAGE'
      ? 'Images must be JPG, PNG or WEBP.'
      : 'Documents must be PDF, Word or Excel files.');
  }
  if (size > config.maxUploadBytes) {
    throw badRequest(`Files must be under ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.`);
  }
}

/** Writes the bytes and returns the public path. Names are never trusted. */
async function store({ tenantId, projectId, originalName, buffer }) {
  const safeExt = path.extname(originalName || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const key = `${tenantId}/${projectId}/${crypto.randomBytes(12).toString('hex')}${safeExt}`;
  const target = path.join(config.uploadDir, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  // UPLOAD_DIR lives under public/, so the static handler serves it directly.
  return { storageKey: key, url: `/${path.relative('public', config.uploadDir)}/${key}`.replace(/\/+/g, '/') };
}

async function upload({ tenantId, actor, projectId, file, data }) {
  const project = await Project.findOne({ tenantId, _id: projectId }).lean();
  if (!project) throw notFound('Project not found.');
  if (!file) throw badRequest('Choose a file to upload.');

  const assetType = data.assetType;
  assertAcceptable({ assetType, mimeType: file.mimetype, size: file.size });

  const categories = assetType === 'IMAGE' ? ProjectAsset.IMAGE_CATEGORIES : ProjectAsset.DOCUMENT_CATEGORIES;
  const category = categories.includes(data.category) ? data.category : 'OTHER';

  const { storageKey, url } = await store({
    tenantId, projectId, originalName: file.originalname, buffer: file.buffer,
  });

  const asset = await ProjectAsset.create({
    tenantId,
    projectId,
    assetType,
    category,
    title: data.title || file.originalname,
    caption: data.caption,
    fileName: file.originalname,
    mimeType: file.mimetype,
    fileSize: file.size,
    storageKey,
    url,
    displayOrder: Number(data.displayOrder) || 0,
    customerVisible: data.customerVisible === '1' || data.customerVisible === true,
    aiUsable: data.aiUsable === '1' || data.aiUsable === true,
    internalNote: data.internalNote,
    uploadedBy: actor?._id,
  });

  // §88: one cover image per project — a second one replaces the first.
  if (assetType === 'IMAGE' && category === 'COVER') {
    await ProjectAsset.updateMany(
      { tenantId, projectId, assetType: 'IMAGE', category: 'COVER', _id: { $ne: asset._id } },
      { $set: { category: 'GALLERY' } },
    );
  }

  await audit.record({
    tenantId, actor, entity: 'ProjectAsset', entityId: asset._id, action: 'UPLOAD',
    after: { projectId, assetType, category, fileName: asset.fileName, customerVisible: asset.customerVisible },
  });
  return asset;
}

async function update({ tenantId, actor, assetId, data }) {
  const asset = await ProjectAsset.findOne({ tenantId, _id: assetId });
  if (!asset) throw notFound('File not found.');
  const before = { customerVisible: asset.customerVisible, aiUsable: asset.aiUsable, category: asset.category };

  const categories = asset.assetType === 'IMAGE' ? ProjectAsset.IMAGE_CATEGORIES : ProjectAsset.DOCUMENT_CATEGORIES;
  if (data.category && categories.includes(data.category)) asset.category = data.category;
  if (data.title !== undefined) asset.title = data.title;
  if (data.caption !== undefined) asset.caption = data.caption;
  if (data.internalNote !== undefined) asset.internalNote = data.internalNote;
  if (data.displayOrder !== undefined) asset.displayOrder = Number(data.displayOrder) || 0;
  asset.customerVisible = data.customerVisible === '1' || data.customerVisible === true;
  asset.aiUsable = data.aiUsable === '1' || data.aiUsable === true;
  await asset.save();

  await audit.record({
    tenantId, actor, entity: 'ProjectAsset', entityId: asset._id, action: 'UPDATE',
    before, after: { customerVisible: asset.customerVisible, aiUsable: asset.aiUsable, category: asset.category },
  });
  return asset;
}

/** §31.4: archive, never delete — a shared quotation may still reference it. */
async function archive({ tenantId, actor, assetId }) {
  const asset = await ProjectAsset.findOne({ tenantId, _id: assetId });
  if (!asset) throw notFound('File not found.');
  asset.archived = true;
  await asset.save();
  await audit.record({ tenantId, actor, entity: 'ProjectAsset', entityId: asset._id, action: 'ARCHIVE' });
  return asset;
}

const forProject = ({ tenantId, projectId, assetType = null, customerOnly = false }) => ProjectAsset.find({
  tenantId,
  projectId,
  archived: { $ne: true },
  ...(assetType ? { assetType } : {}),
  ...(customerOnly ? { customerVisible: true } : {}),
}).sort({ assetType: 1, displayOrder: 1, uploadedAt: 1 }).lean();

const coverFor = ({ tenantId, projectId }) => ProjectAsset.findOne({
  tenantId, projectId, assetType: 'IMAGE', category: 'COVER', archived: { $ne: true },
}).lean();

module.exports = {
  IMAGE_MIME, DOCUMENT_MIME, assertAcceptable, upload, update, archive, forProject, coverFor,
};
