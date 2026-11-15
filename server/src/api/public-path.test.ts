import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { publicPathFrom } from "./public-path.js";

describe("where the server is reached from", () => {
  it("is the root when there is no prefix", () => {
    assert.equal(publicPathFrom({}, "/api/device"), "");
  });

  it("is the prefix the proxy said", () => {
    assert.equal(
      publicPathFrom({ "x-forwarded-prefix": "/api/hassio_ingress/TOKEN" }, "/api/device"),
      "/api/hassio_ingress/TOKEN",
    );
  });

  it("has no trailing slash", () => {
    assert.equal(
      publicPathFrom({ "x-forwarded-prefix": "/api/hassio_ingress/TOKEN/" }, "/api/device"),
      "/api/hassio_ingress/TOKEN",
    );
  });

  it("is empty when the prefix is only a slash", () => {
    assert.equal(publicPathFrom({ "x-forwarded-prefix": "/" }, "/api/device"), "");
  });

  it("takes the first prefix when there are several", () => {
    assert.equal(
      publicPathFrom({ "x-forwarded-prefix": ["/one", "/two"] }, "/api/device"),
      "/one",
    );
  });
});
