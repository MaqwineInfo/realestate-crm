const { unprocessable } = require('../lib/errors');

/**
 * Spec §62: all mutation validation happens server-side. Zod schema in,
 * parsed+coerced data on req.data, friendly field errors out.
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '_';
        if (!details[path]) details[path] = issue.message;
      }
      return next(unprocessable('Please correct the highlighted fields.', details));
    }
    req.data = result.data;
    next();
  };
}

module.exports = validate;
