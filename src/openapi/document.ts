import { z } from "zod";

import packageMetadata from "../../package.json";
import { HealthResponseSchema } from "../contracts";

export function generateOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Clothing Commerce API",
      version: packageMetadata.version,
    },
    paths: {
      "/api/v1/health": {
        get: {
          operationId: "getHealth",
          responses: {
            "200": {
              description: "API is healthy",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        HealthResponse: z.toJSONSchema(HealthResponseSchema, { target: "draft-7" }),
      },
    },
  } as const;
}
