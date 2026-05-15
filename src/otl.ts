import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

export const otlLayer = (): Layer.Layer<never> => {
  const baseUrl = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim().replace(/\/+$/, "")
  if (!baseUrl) return Layer.empty

  return Layer.merge(
    OtlpTracer.layer({
      url: `${baseUrl}/v1/traces`,
      resource: {
        serviceName: "pie",
        serviceVersion: "0.1.0",
      },
    }),
    OtlpLogger.layer({
      url: `${baseUrl}/v1/logs`,
      resource: {
        serviceName: "pie",
        serviceVersion: "0.1.0",
      },
    }),
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
}
