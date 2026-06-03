import { Logger } from "pino";
import { AuthenticatedUser } from "../middleware/auth";

declare global {
  namespace Express {
    interface Request {
      log: Logger;
      user?: AuthenticatedUser;
    }
  }
}

export {};
