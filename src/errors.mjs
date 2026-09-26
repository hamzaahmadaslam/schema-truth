/** An error whose message is written for the person running the tool. The CLI prints it without a stack trace. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}
