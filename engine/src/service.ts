import { Schema } from "effect";

export const ServiceSchema = Schema.Struct({
  checkedAt: Schema.NullOr(Schema.String),
  localUrl: Schema.String,
  name: Schema.String,
  originStatus: Schema.NullOr(Schema.Literal("online", "offline")),
  publicStatus: Schema.Literal("reachable", "unknown", "unreachable"),
  publicUrl: Schema.NullOr(Schema.String),
  shared: Schema.Boolean,
  tunnelStatus: Schema.NullOr(
    Schema.Literal("connected", "connecting", "error")
  ),
});

export type Service = Schema.Schema.Type<typeof ServiceSchema>;

export const registeredService = (name: string, localUrl: string): Service => ({
  checkedAt: null,
  localUrl,
  name,
  originStatus: null,
  publicStatus: "unknown",
  publicUrl: null,
  shared: false,
  tunnelStatus: null,
});
