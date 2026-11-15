"use client";
import { useRouter } from "next/navigation";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  onBack?: () => void;
  rightSlot?: React.ReactNode;
  gradient?: string;
}

export default function PageHeader({
  title, subtitle, backHref, onBack, rightSlot,
}: PageHeaderProps) {
  const router = useRouter();

  const handleBack = () => {
    if (onBack) { onBack(); return; }
    if (backHref) { router.push(backHref); return; }
    router.back();
  };

  return (
    <header className="bg-white border-b border-gray-100 px-4 pb-4" style={{ paddingTop: "calc(2rem + env(safe-area-inset-top, 0px))" }}>
      <div className="flex items-center gap-3 max-w-lg mx-auto min-h-9">
        {/* Back button */}
        <button
          onClick={handleBack}
          className="w-9 h-9 rounded-full border border-gray-200 flex items-center justify-center flex-shrink-0 active:scale-95 transition-transform hover:bg-gray-50"
          aria-label="Go back"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="#374151" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          <h1 className="text-gray-900 font-bold text-lg truncate">{title}</h1>
          {subtitle && <p className="text-gray-500 text-xs mt-0.5">{subtitle}</p>}
        </div>

        {rightSlot && <div className="flex-shrink-0">{rightSlot}</div>}
      </div>
    </header>
  );
}
