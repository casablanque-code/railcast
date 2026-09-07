"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";

// The landing page is rendered for everyone by default (fast, no blocking
// spinner for the common anonymous visitor). If it turns out there's a
// valid session, hand off to the dashboard instead — mirrors the check on
// /dashboard, which does the opposite (401 there sends you back here).
export function LandingGate() {
  useEffect(() => {
    api
      .me()
      .then(() => {
        window.location.href = "/dashboard";
      })
      .catch(() => {
        // Not logged in (or API unreachable) — stay on the landing page.
      });
  }, []);

  return null;
}
