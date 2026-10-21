export class BrokerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.details = details;
  }
}
