import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defineMappingPolicy,
  makeMapper,
  source,
  transform,
} from "../dist/index.js";

test("runtime mapper reads paths, defaults, and transform callbacks", () => {
  const spec = {
    id: source("user_id"),
    name: source("profile.name"),
    ageLabel: transform("age", (value) => `${value} years`),
    status: source("status", { defaultValue: "ACTIVE" }),
  };

  const mapper = makeMapper(spec);

  assert.deepEqual(
    mapper({ user_id: "u1", profile: { name: "Lux" }, age: 7 }),
    {
      id: "u1",
      name: "Lux",
      ageLabel: "7 years",
      status: "ACTIVE",
    }
  );
});

test("runtime mapper can enforce mapping policy violations", () => {
  const policy = defineMappingPolicy()({
    id: source("user_id"),
  });

  assert.throws(
    () =>
      makeMapper(
        {
          userId: source("user_id"),
        },
        { policy, policyMode: "error" }
      ),
    /Mapping policy violation/
  );
});
