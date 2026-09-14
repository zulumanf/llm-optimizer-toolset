import { publicDatasetFile } from "@/lib/marketing/public-dataset";

export const dynamic = "force-static";

export function generateStaticParams(): { file: string }[] {
  return [
    "real-estate-ai-visibility-benchmark.csv",
    "real-estate-ai-visibility-benchmark-domains.csv",
    "real-estate-ai-visibility-benchmark-entities.csv",
    "real-estate-ai-visibility-benchmark.json",
  ].map((file) => ({ file }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  const found = publicDatasetFile(file);
  if (!found) return new Response("Not found", { status: 404 });
  return new Response(found.body, {
    headers: {
      "content-type": found.contentType,
      "content-disposition": `attachment; filename="${file}"`,
      "cache-control": "public, max-age=86400",
    },
  });
}
