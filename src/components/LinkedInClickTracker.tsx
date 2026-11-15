"use client";

import { useEffect } from "react";

const CARD_SELECTOR = 'button[aria-label="Open Student Platform LinkedIn post"]';
const POPUP_SEEN_KEY = "student-platform-linkedin-feedback-popup-v1";
const LINKEDIN_POST_URL = "https://www.linkedin.com/posts/krupal-sai_i-built-a-real-world-student-petition-platform-activity-7501959369874632705-mi6a?utm_source=social_share_send&utm_medium=android_app&rcm=ACoAADFRfV8BdHlN1A5tq-HuM9I4YPc_XkjPbUA&utm_campaign=copy_link";

/**
 * Tracks LinkedIn taps (for /admin/analytics/linkedin) and shows a one-time
 * feedback popup on the student dashboard.
 *
 * Does NOT touch the dashboard card's own DOM any more. It used to rewrite
 * the card's innerHTML in white text on white/colored backgrounds, which
 * made sense on the old bright-gradient card design. Item #204's redesign
 * turned that card into a plain white row and had no idea this script
 * existed — the result was white-on-white: the button stayed clickable
 * (which is why taps kept getting tracked) but visually blank, which is
 * almost certainly what read as "not showing." The dashboard card already
 * renders its own title/subtitle in React — nothing here needs to
 * duplicate or repaint it.
 */
export default function LinkedInClickTracker() {
  useEffect(() => {
    const sendClickAnalytics = () => {
      const token = localStorage.getItem("sp_token") ?? "";
      if (!token) return;
      void fetch("/api/analytics/linkedin", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "click" }),
        keepalive: true,
      }).catch(() => undefined);
    };

    const openLinkedIn = () => {
      sendClickAnalytics();
      window.open(LINKEDIN_POST_URL, "_blank", "noopener,noreferrer");
    };

    const showPopupOnce = () => {
      if (window.location.pathname !== "/dashboard") return;
      if (!localStorage.getItem("sp_token")) return;
      if (localStorage.getItem(POPUP_SEEN_KEY) === "1") return;

      // Mark it seen when displayed, so closing it does not make it appear again.
      localStorage.setItem(POPUP_SEEN_KEY, "1");

      const overlay = document.createElement("div");
      overlay.setAttribute("data-linkedin-popup", "true");
      overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.58);display:flex;align-items:flex-end;justify-content:center;padding:18px;backdrop-filter:blur(3px);";
      overlay.innerHTML = `
        <div role="dialog" aria-modal="true" aria-labelledby="linkedin-feedback-title" style="width:100%;max-width:430px;background:#fff;border-radius:22px;padding:22px;box-shadow:0 24px 70px rgba(0,0,0,.28);animation:linkedinPopupUp .28s ease-out;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
            <div style="width:44px;height:44px;border-radius:13px;background:#e8f3ff;color:#0a66c2;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:900;letter-spacing:-2px;">in</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:10px;font-weight:800;letter-spacing:1.4px;color:#64748b;margin-bottom:3px;">LINKEDIN</div>
              <h2 id="linkedin-feedback-title" style="margin:0;color:#0f172a;font-size:19px;line-height:1.25;font-weight:800;">Student Platform needs your feedback</h2>
            </div>
            <button type="button" data-linkedin-close aria-label="Close" style="border:0;background:#f1f5f9;color:#64748b;width:32px;height:32px;border-radius:50%;font-size:20px;cursor:pointer;">×</button>
          </div>
          <p style="margin:0 0 18px;color:#475569;font-size:13.5px;line-height:1.6;">We’ve shared our Student Platform journey on LinkedIn. Take a look at the post and tell us what you think. Your reaction and comments mean a lot to us.</p>
          <button type="button" data-linkedin-open-popup style="width:100%;border:0;border-radius:12px;padding:13px 16px;background:#0a66c2;color:#fff;font-weight:800;font-size:14px;cursor:pointer;">View Post →</button>
        </div>
        <style>@keyframes linkedinPopupUp{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:translateY(0)}}</style>
      `;

      const close = () => overlay.remove();
      overlay.querySelector("[data-linkedin-close]")?.addEventListener("click", close);
      overlay.querySelector("[data-linkedin-open-popup]")?.addEventListener("click", () => {
        openLinkedIn();
        close();
      });
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close();
      });
      document.body.appendChild(overlay);
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest?.(CARD_SELECTOR);
      if (!button) return;
      sendClickAnalytics();
    };

    document.addEventListener("click", onClick, true);
    const popupTimer = window.setTimeout(showPopupOnce, 900);

    return () => {
      window.clearTimeout(popupTimer);
      document.removeEventListener("click", onClick, true);
      document.querySelector('[data-linkedin-popup="true"]')?.remove();
    };
  }, []);

  return null;
}
