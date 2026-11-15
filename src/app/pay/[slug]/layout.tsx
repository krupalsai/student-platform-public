export default async function PaySlugLayout({
  children,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  // The canonical /pay/[slug] page owns the active gateway UI.
  // Do not redirect between /pay and /pay/razorpay: that can create a loop
  // when Razorpay is enabled. Legacy links are handled by the legacy route.
  return children;
}
