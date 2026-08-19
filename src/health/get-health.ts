import packageMetadata from "../../package.json";
import { HealthResponseSchema, type HealthResponse } from "../contracts";

export function getHealth(): HealthResponse {
  return HealthResponseSchema.parse({
    status: "ok",
    version: packageMetadata.version,
  });
}
