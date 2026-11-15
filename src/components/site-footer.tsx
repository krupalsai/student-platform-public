import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="border-t border-gray-100 bg-white">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
          <span className="text-sm text-gray-500">© {new Date().getFullYear()} Student Platform</span>
          <nav className="flex flex-wrap gap-x-6 gap-y-2 justify-center text-sm">
            <Link href="/#about" className="text-gray-500 hover:text-primary transition-colors">About Us</Link>
            <Link href="/contact" className="text-gray-500 hover:text-primary transition-colors">Contact Us</Link>
            <Link href="/privacy-policy" className="text-gray-500 hover:text-primary transition-colors">Privacy Policy</Link>
            <Link href="/refund-policy" className="text-gray-500 hover:text-primary transition-colors">Refund & Cancellation</Link>
            <Link href="/shipping-policy" className="text-gray-500 hover:text-primary transition-colors">Shipping & Delivery</Link>
            <Link href="/terms" className="text-gray-500 hover:text-primary transition-colors">Terms & Conditions</Link>
            <Link href="/accessibility" className="text-gray-500 hover:text-primary transition-colors">Accessibility</Link>
          </nav>
        </div>
        <p className="mt-4 text-center sm:text-left text-xs text-gray-500">Operated by: Kusanapelli Sai Krupal</p>
      </div>
    </footer>
  );
}
