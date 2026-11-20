class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
const conflict = (msg) => new HttpError(409, msg);

module.exports = { HttpError, badRequest, notFound, conflict };
