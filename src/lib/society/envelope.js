/**
 * The society API wire shape, reproduced exactly.
 *
 * SOCIETY-PLAN.md D2: the mobile app's contract is matched byte-for-byte, so
 * this is a faithful port of the source's `config/response.js` rather than
 * something designed. Three details are load-bearing and easy to "improve" by
 * accident:
 *
 *  1. The envelope is `{ message, result }`. There is no `status`, no `data`,
 *     and no `success` — the HTTP status code carries that.
 *  2. An empty result serialises as `{}`, not `[]` and not `null`. The source
 *     does this with `result.length == 0 ? {} : result`, which means an empty
 *     ARRAY also becomes `{}`. Clients depend on it.
 *  3. Paginated lists use a different, nested shape (`makeDataTablesResponse`)
 *     whose keys are `perPage`, `totalElements`, `totalPages`, `pageNumber`.
 *
 * `emptyIsObject` below reproduces (2) including its quirk for arrays. Do not
 * "fix" it here — fix it in a versioned endpoint if it ever needs fixing.
 */

/** The source's `result.length == 0 ? {} : result`, quirk intact. */
function emptyIsObject(result) {
  if (result === null || result === undefined) return {};
  if (typeof result.length === 'number' && result.length === 0) return {};
  return result;
}

/** `{ message, result }` — the shape every non-paginated society endpoint returns. */
function toJson(message, result = []) {
  return { message, result: emptyIsObject(result) };
}

/**
 * The source's paginated shape. `query` is `{ rows, count }`; the odd
 * `Math.ceil(Math.abs(count / pageSize))` is kept because a client reading
 * `totalPages` must see the same number it sees today.
 */
function makeDataTablesResponse(query, pageSize, page, tableHeaders, orderBy) {
  return {
    response: {
      data: query.rows,
      perPage: pageSize,
      totalElements: query.count,
      totalPages: Math.ceil(Math.abs(parseInt(query.count, 10) / pageSize)),
      pageNumber: page || 1,
      tableHeaders,
      orderBy,
    },
  };
}

/**
 * The source throws `Error` objects carrying a `statusCode`, caught by each
 * controller's try/catch. Ported so controller bodies read the same, but the
 * thrown object is this codebase's `AppError` so `middleware/errors.js` can
 * render it without a special case.
 */
function throwCustomError(statusCode, message) {
  const { AppError } = require('../errors');
  throw new AppError(message, { status: statusCode, code: 'SOCIETY_ERROR' });
}

module.exports = { toJson, makeDataTablesResponse, throwCustomError, emptyIsObject };
