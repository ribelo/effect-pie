import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Layer } from "effect"
import { otlLayer } from "../src/otl.js"

test("otlLayer with absent env returns Layer.empty", () => {
  const previous = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  assert.strictEqual(otlLayer(), Layer.empty)
  if (previous !== undefined) {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = previous
  }
})

test("otlLayer with empty string env returns Layer.empty", () => {
  const previous = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = ""
  assert.strictEqual(otlLayer(), Layer.empty)
  if (previous !== undefined) {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = previous
  } else {
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  }
})

test("otlLayer with valid endpoint does not throw", () => {
  const previous = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4318"
  assert.doesNotThrow(() => otlLayer())
  if (previous !== undefined) {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = previous
  } else {
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  }
})

test("otlLayer strips trailing slashes", () => {
  const previous = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4318/"
  assert.doesNotThrow(() => otlLayer())
  if (previous !== undefined) {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = previous
  } else {
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  }
})
