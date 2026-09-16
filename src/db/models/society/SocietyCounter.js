const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');

/**
 * Atomic sequence source for human-readable reference numbers — CM-001,
 * MNT-0042 and so on.
 *
 * The canonical service generated these by reading the most recent document
 * and adding one, which is a read-then-write race: two complaints filed in the
 * same second get the same id, and the unique index then rejects one of them.
 * The legacy service already had counter collections for exactly this; they are
 * kept and made the single mechanism.
 *
 * `next()` is a single-document atomic `$inc` with upsert — the same
 * conditional-update discipline the rest of this codebase uses instead of
 * transactions (§87).
 *
 * One document per (societyCode, kind, date). `date` is the period the sequence
 * resets on — pass a fixed string for a never-resetting counter.
 */
const counterSchema = new Schema({
  societyCode: { type: String, required: true, trim: true, uppercase: true },
  kind: { type: String, required: true, trim: true },
  date: { type: String, required: true, trim: true },
  sequence: { type: Number, default: 0 },
}, { timestamps: true, collection: 'society_counters' });

counterSchema.plugin(platformScoped);
counterSchema.index({ societyCode: 1, kind: 1, date: 1 }, { unique: true });

/** Returns the next sequence number for this counter. Never returns the same value twice. */
counterSchema.statics.next = async function next({ societyCode, kind, date = 'ALL' }) {
  const doc = await this.findOneAndUpdate(
    { societyCode, kind, date },
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return doc.sequence;
};

/** `CM-001` style: zero-padded to `width`. */
counterSchema.statics.nextRef = async function nextRef({
  societyCode, kind, date = 'ALL', prefix, width = 3,
}) {
  const seq = await this.next({ societyCode, kind, date });
  return `${prefix}-${String(seq).padStart(width, '0')}`;
};

module.exports = model('SocietyCounter', counterSchema);
