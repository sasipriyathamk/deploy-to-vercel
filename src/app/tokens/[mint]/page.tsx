import { TokenDetail } from "@/components/token-detail";

export default async function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return <TokenDetail mint={mint} />;
}
