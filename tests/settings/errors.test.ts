import { describe, expect, it } from "vitest";

import { settingsDatabaseError } from "../../src/settings/errors";

describe("settings topology errors", () => {
  it.each([
    ["SF409", "STOREFRONT_LOCATION_NOT_OPERATIONAL"],
    ["SD409", "STOREFRONT_DEPENDENCY_CONFLICT"],
    ["RG409", "REGISTER_LOCATION_NOT_OPERATIONAL"],
    ["RD409", "REGISTER_DEPENDENCY_CONFLICT"],
  ] as const)("maps %s to stable domain code %s", (databaseCode, domainCode) => {
    expect(settingsDatabaseError({ code: databaseCode })).toMatchObject({
      code: domainCode,
      httpStatus: 409,
    });
  });
});
