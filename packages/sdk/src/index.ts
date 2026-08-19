import { HealthResponseSchema, type HealthResponse } from "../../../src/contracts";
import packageMetadata from "../package.json";

export const SDK_VERSION = packageMetadata.version;

export type ClientType = "pos-desktop" | "storefront" | "admin-mobile";

export interface ClientMetadata {
  type: ClientType;
  version: string;
}

export interface CommerceClientOptions {
  baseUrl: string;
  client?: ClientMetadata;
  fetch?: typeof globalThis.fetch;
}

export interface CommerceClient {
  getHealth(): Promise<HealthResponse>;
}

export class CommerceSdkError extends Error {}

export class ApiNetworkError extends CommerceSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiNetworkError";
  }
}

export class ApiHttpError extends CommerceSdkError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export class ApiContractError extends CommerceSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiContractError";
  }
}

function clientHeaders(client?: ClientMetadata): HeadersInit {
  return {
    Accept: "application/json",
    ...(client
      ? {
          "X-Client-Type": client.type,
          "X-Client-Version": client.version,
        }
      : {}),
  };
}

export function createCommerceClient({
  baseUrl,
  client,
  fetch: fetchImplementation = globalThis.fetch,
}: CommerceClientOptions): CommerceClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  return {
    async getHealth() {
      let response: Response;

      try {
        response = await fetchImplementation(`${normalizedBaseUrl}/api/v1/health`, {
          headers: clientHeaders(client),
        });
      } catch (error) {
        throw new ApiNetworkError("Unable to reach the Commerce API", { cause: error });
      }

      if (!response.ok) {
        throw new ApiHttpError("Health request failed", response.status);
      }

      try {
        return HealthResponseSchema.parse(await response.json());
      } catch (error) {
        throw new ApiContractError("Health response violated the API contract", { cause: error });
      }
    },
  };
}

export type { HealthResponse };
