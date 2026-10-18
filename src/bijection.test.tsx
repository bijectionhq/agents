import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import {
  BijectionProvider,
  BijectionReactClient,
  useBijection,
} from "bijection/react";
import { makeFunctionReference, getFunctionName } from "bijection/server";
import {
  BijectionError,
  v,
  bijectionToJson,
  jsonToBijection,
} from "bijection/values";
import { parse } from "@bijectionhq/helpers/validators";
import { useQuery } from "@bijectionhq/helpers/react";
import { useUIMessages } from "./react/index.js";
import * as conversations from "./index.js";
import { defineAgent as nativeDefineAgent } from "./native/index.js";

test("conversation and governed service APIs have distinct public entries", () => {
  expect(conversations.Agent).toBeTypeOf("function");
  expect(conversations).not.toHaveProperty("defineAgent");
  expect(nativeDefineAgent).toBeTypeOf("function");
});

test("helper validators retain exact values and inherited identity markers", () => {
  const value = {
    amount: 9007199254740993n,
    bytes: new Uint8Array([0, 255]).buffer,
  };
  expect(
    parse(v.object({ amount: v.int64(), bytes: v.bytes() }), value),
  ).toEqual(value);
  expect(jsonToBijection(bijectionToJson(value))).toEqual(value);
  expect(v.string().isConvexValidator).toBe(true);
  expect(
    (new BijectionError("refused") as any)[Symbol.for("ConvexError")],
  ).toBe(true);
  expect(getFunctionName(makeFunctionReference("threads:get"))).toBe(
    "threads:get",
  );
});

test("component hooks share the application's SDK and React context", async () => {
  const client = new BijectionReactClient("http://127.0.0.1:3210", {
    disabled: true,
  });
  function Messages() {
    expect(useBijection()).toBe(client);
    const query = makeFunctionReference<"query">("messages:list");
    useQuery(query, "skip");
    const { results } = useUIMessages(query as any, "skip", {
      initialNumItems: 1,
    });
    return createElement("span", null, results.length);
  }
  try {
    expect(
      renderToString(
        createElement(BijectionProvider, { client }, createElement(Messages)),
      ),
    ).toContain("0");
  } finally {
    await client.close();
  }
});
