import { Data } from "effect";

export class PortupFailure extends Data.TaggedError("PortupFailure")<{
  readonly code: string;
  readonly message: string;
}> {}
