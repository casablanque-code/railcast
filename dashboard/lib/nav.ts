// Full-page navigation, behind a function so component tests can replace it
// (jsdom doesn't let a test stub window.location).
export function goTo(url: string): void {
  window.location.href = url;
}
