export const readStreamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => {
  if (stream === null) {
    return ""
  }

  return await new Response(stream).text()
}
