/** Native runs and upstream conversation storage share one SDK. */
export * from "./vercel/index.js";
export * from "./native/index.js";

export { defineVerification } from "./verification/definition.js";
export type {
  VerificationDefinition,
  VerificationDeclaration,
  ContextCheckResult,
  VerificationResource,
} from "./verification/definition.js";

export { verificationModule } from "./verification/boundary.js";
export type {
  VerificationModuleOptions,
  VerificationInteraction,
  VerificationAdmission,
} from "./verification/boundary.js";

export {
  agentMailDefinition,
  agentMailMessageFields,
} from "./providers/agentmail.js";
export {
  twilioVerifyDefinition,
  twilioVerificationFields,
} from "./providers/twilio.js";

export {
  chatTransportDefinition,
  chatDestinationFields,
} from "./providers/chat.js";
