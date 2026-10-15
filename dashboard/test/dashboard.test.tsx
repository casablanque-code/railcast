import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DashboardPage from "@/app/dashboard/page";
import LandingPage from "@/app/page";
import MigratePage from "@/app/migrate/page";
import { api, ApiError, type App, type Release } from "@/lib/api";
import { goTo } from "@/lib/nav";

// The API client and navigation are replaced; everything else is the real page,
// driven the way a person would: clicking buttons, typing, confirming.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  const fn = () => vi.fn();
  return {
    ...actual,
    api: {
      base: "https://railcast.test",
      me: fn(),
      listApps: fn(),
      listTokens: fn(),
      listReleases: fn(),
      createToken: fn(),
      revokeToken: fn(),
      deleteApp: fn(),
      deleteRelease: fn(),
      yankRelease: fn(),
      unyankRelease: fn(),
      promoteRelease: fn(),
      setFeedRedirect: fn(),
      exportApp: fn(),
      deleteAccount: fn(),
    },
  };
});
vi.mock("@/lib/nav", () => ({ goTo: vi.fn() }));

const ME = { id: "u1", email: "Me@Example.com" };

const makeApp = (over: Partial<App> = {}): App => ({
  id: "app1",
  name: "MyApp",
  signing_public_key: "PUBKEY",
  beta_token: "beta",
  feed_redirect_url: null,
  created_at: 1760000000,
  ...over,
});

const makeRelease = (over: Partial<Release> = {}): Release => ({
  id: 1,
  channel: "stable",
  version: "1.0.0",
  build_number: 1,
  file_key: "app1/MyApp-1.0.0.zip",
  file_size: 1024,
  sha256: "a".repeat(64),
  release_notes: null,
  critical: 0,
  phased_rollout_interval: null,
  min_system_version: null,
  yanked: 0,
  created_at: 1760000000,
  ...over,
});

let confirm: MockInstance<typeof window.confirm>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.me).mockResolvedValue(ME);
  vi.mocked(api.listApps).mockResolvedValue({ apps: [makeApp()] });
  vi.mocked(api.listTokens).mockResolvedValue({ tokens: [] });
  vi.mocked(api.listReleases).mockResolvedValue({
    app_id: "app1",
    app_name: "MyApp",
    history_limit: 10,
    releases: [makeRelease({ id: 2, version: "1.1.0", build_number: 2 }), makeRelease()],
  });
  confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
});

// Renders the dashboard and opens the releases panel of the only app.
async function openReleases() {
  const user = userEvent.setup();
  render(<DashboardPage />);
  await user.click(await screen.findByRole("button", { name: "releases" }));
  await screen.findByText(/1\.1\.0/);
  return user;
}

describe("yank / restore", () => {
  it("asks before hiding a release, and does nothing if you decline", async () => {
    confirm.mockReturnValue(false);
    const user = await openReleases();

    await user.click(screen.getByRole("button", { name: "Yank 1.1.0 (stable)" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Sparkle never downgrades"));
    expect(api.yankRelease).not.toHaveBeenCalled();
    expect(screen.queryByText("yanked")).not.toBeInTheDocument();
  });

  it("hides the release and offers Restore, which needs no confirmation", async () => {
    vi.mocked(api.yankRelease).mockResolvedValue(undefined);
    vi.mocked(api.unyankRelease).mockResolvedValue(undefined);
    const user = await openReleases();

    await user.click(screen.getByRole("button", { name: "Yank 1.1.0 (stable)" }));
    expect(api.yankRelease).toHaveBeenCalledWith("app1", 2);
    expect(await screen.findByText("yanked")).toBeInTheDocument();
    // the other release is untouched
    expect(screen.getByRole("button", { name: "Yank 1.0.0 (stable)" })).toBeInTheDocument();

    confirm.mockClear();
    await user.click(await screen.findByRole("button", { name: "Restore 1.1.0 (stable)" }));
    expect(api.unyankRelease).toHaveBeenCalledWith("app1", 2);
    await waitFor(() => expect(screen.queryByText("yanked")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Yank 1.1.0 (stable)" })).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows the server's reason when a release can't be yanked, and changes nothing", async () => {
    vi.mocked(api.yankRelease).mockRejectedValue(
      new ApiError(409, "Cannot yank the only live release on channel 'stable' — publish a replacement first.")
    );
    const user = await openReleases();

    await user.click(screen.getByRole("button", { name: "Yank 1.1.0 (stable)" }));

    expect(await screen.findByText(/only live release/)).toBeInTheDocument();
    expect(screen.queryByText("yanked")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yank 1.1.0 (stable)" })).toBeEnabled();
  });
});

describe("promote", () => {
  const beta = (over: Partial<Release> = {}) =>
    makeRelease({ id: 3, channel: "beta", version: "2.0.0", build_number: 5, file_key: "app1/MyApp-2.0.0.zip", ...over });

  async function openReleasesWith(releases: Release[]) {
    vi.mocked(api.listReleases).mockResolvedValue({ app_id: "app1", app_name: "MyApp", history_limit: 10, releases });
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(await screen.findByRole("button", { name: "releases" }));
    await screen.findAllByText(/2\.0\.0|1\.0\.0/);
    return user;
  }

  it("is offered on beta builds only, and releases to stable after confirming", async () => {
    vi.mocked(api.promoteRelease).mockResolvedValue({ id: 9, channel: "stable", version: "2.0.0", build_number: 5 });
    const user = await openReleasesWith([beta(), makeRelease()]);

    expect(screen.queryByRole("button", { name: /Promote 1\.0\.0/ })).not.toBeInTheDocument(); // stable build
    // after the promotion the list is reloaded and shows the stable copy
    vi.mocked(api.listReleases).mockResolvedValue({
      app_id: "app1", app_name: "MyApp", history_limit: 10,
      releases: [beta(), makeRelease({ id: 9, channel: "stable", version: "2.0.0", build_number: 5, file_key: "app1/MyApp-2.0.0.zip" }), makeRelease()],
    });
    await user.click(screen.getByRole("button", { name: "Promote 2.0.0 to stable" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("nothing is uploaded again"));
    expect(api.promoteRelease).toHaveBeenCalledWith("app1", 3, "stable");
    await waitFor(() => expect(api.listReleases).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Promote 2.0.0 to stable" })).not.toBeInTheDocument());
  });

  it("does nothing when you decline the confirmation", async () => {
    confirm.mockReturnValue(false);
    const user = await openReleasesWith([beta(), makeRelease()]);

    await user.click(screen.getByRole("button", { name: "Promote 2.0.0 to stable" }));

    expect(api.promoteRelease).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the build isn't higher than stable's latest", async () => {
    vi.mocked(api.promoteRelease).mockRejectedValue(
      new ApiError(409, "Build 5 is not higher than the latest build (8) on channel 'stable'. Publish a newer build instead.")
    );
    const user = await openReleasesWith([beta(), makeRelease({ build_number: 8 })]);

    await user.click(screen.getByRole("button", { name: "Promote 2.0.0 to stable" }));

    expect(await screen.findByText(/Publish a newer build instead/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promote 2.0.0 to stable" })).toBeEnabled();
  });

  it("isn't offered when the build is already on stable, or is yanked", async () => {
    await openReleasesWith([
      beta({ id: 3 }),
      makeRelease({ id: 9, channel: "stable", version: "2.0.0", build_number: 5, file_key: "app1/MyApp-2.0.0.zip" }),
      beta({ id: 4, version: "2.1.0", build_number: 6, file_key: "app1/MyApp-2.1.0.zip", yanked: 1 }),
    ]);

    expect(screen.queryByRole("button", { name: /Promote/ })).not.toBeInTheDocument();
  });
});

describe("move the feed", () => {
  const target = "https://updates.example.com/appcast.xml";

  it("sets a redirect after confirming, shows it on the app, and clears it again", async () => {
    vi.mocked(api.setFeedRedirect).mockResolvedValue({ feed_redirect_url: target });
    const user = await openReleases();

    const button = screen.getByRole("button", { name: "Redirect" });
    expect(button).toBeDisabled(); // nothing typed yet
    await user.type(screen.getByPlaceholderText(target), target);
    expect(button).toBeEnabled();

    vi.mocked(api.listApps).mockResolvedValue({ apps: [makeApp({ feed_redirect_url: target })] });
    await user.click(button);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(target));
    expect(api.setFeedRedirect).toHaveBeenCalledWith("app1", target);
    expect(await screen.findByText(/Feed redirects to/)).toBeInTheDocument();

    vi.mocked(api.setFeedRedirect).mockResolvedValue({ feed_redirect_url: null });
    vi.mocked(api.listApps).mockResolvedValue({ apps: [makeApp()] });
    await user.click(screen.getByRole("button", { name: "Clear redirect" }));

    expect(api.setFeedRedirect).toHaveBeenLastCalledWith("app1", null);
    await waitFor(() => expect(screen.queryByText(/Feed redirects to/)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Clear redirect" })).not.toBeInTheDocument();
  });

  it("does nothing when you decline the confirmation", async () => {
    confirm.mockReturnValue(false);
    const user = await openReleases();

    await user.type(screen.getByPlaceholderText(target), target);
    await user.click(screen.getByRole("button", { name: "Redirect" }));

    expect(api.setFeedRedirect).not.toHaveBeenCalled();
  });

  it("shows the server's message when it rejects the URL", async () => {
    vi.mocked(api.setFeedRedirect).mockRejectedValue(new ApiError(400, "url must be https"));
    const user = await openReleases();

    await user.type(screen.getByPlaceholderText(target), "http://insecure.example.com/appcast.xml");
    await user.click(screen.getByRole("button", { name: "Redirect" }));

    expect(await screen.findByText("url must be https")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Redirect" })).toBeEnabled();
  });
});

describe("export", () => {
  const exported = {
    app: { id: "app1", name: "MyApp", signing_public_key: "PUBKEY", feed_redirect_url: null },
    public_file_base_url: "https://dl.example.com",
    history_limit: 10,
    releases: [{ ...makeRelease(), signature: "SIG" }],
    appcasts: { stable: "<rss/>" },
  };

  function stubDownload() {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:fake");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    return { createObjectURL, click };
  }

  it("downloads the export as <app>-export.json, passing the files URL along", async () => {
    vi.mocked(api.exportApp).mockResolvedValue(exported);
    const { createObjectURL, click } = stubDownload();
    const user = await openReleases();

    await user.type(screen.getByPlaceholderText(/Files URL for the feeds/), "https://updates.example.com/files");
    await user.click(screen.getByRole("button", { name: "Download JSON" }));

    expect(api.exportApp).toHaveBeenCalledWith("app1", "https://updates.example.com/files");
    await waitFor(() => expect(click).toHaveBeenCalled());
    const blob = createObjectURL.mock.calls[0][0];
    expect(JSON.parse(await blob.text())).toEqual(exported);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("app1-export.json");
  });

  it("works without a files URL", async () => {
    vi.mocked(api.exportApp).mockResolvedValue({ ...exported, appcasts: null });
    stubDownload();
    const user = await openReleases();

    await user.click(screen.getByRole("button", { name: "Download JSON" }));

    expect(api.exportApp).toHaveBeenCalledWith("app1", undefined);
  });

  it("shows the server's message when the export is refused", async () => {
    vi.mocked(api.exportApp).mockRejectedValue(new ApiError(400, "files_url must be https"));
    const { click } = stubDownload();
    const user = await openReleases();

    await user.type(screen.getByPlaceholderText(/Files URL for the feeds/), "http://example.com/files");
    await user.click(screen.getByRole("button", { name: "Download JSON" }));

    expect(await screen.findByText("files_url must be https")).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  });
});

describe("delete account", () => {
  async function openDeleteForm() {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(await screen.findByRole("button", { name: "Delete account…" }));
    return user;
  }

  it("stays disabled until the email matches (in any case), then deletes and leaves", async () => {
    vi.mocked(api.deleteAccount).mockResolvedValue(undefined);
    const user = await openDeleteForm();
    const input = screen.getByLabelText(/Type your email/);
    const go = screen.getByRole("button", { name: "Delete everything" });

    expect(go).toBeDisabled();
    await user.type(input, "someone-else@example.com");
    expect(go).toBeDisabled();

    await user.clear(input);
    await user.type(input, "me@example.com"); // the account is Me@Example.com
    expect(go).toBeEnabled();
    await user.click(go);

    expect(api.deleteAccount).toHaveBeenCalledWith("me@example.com");
    await waitFor(() => expect(goTo).toHaveBeenCalledWith("/"));
  });

  it("cancel closes the form and forgets what was typed", async () => {
    const user = await openDeleteForm();
    await user.type(screen.getByLabelText(/Type your email/), "me@example.com");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/Type your email/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete account…" }));
    expect(screen.getByLabelText(/Type your email/)).toHaveValue("");
    expect(api.deleteAccount).not.toHaveBeenCalled();
  });

  it("shows the server's message if deletion fails, and stays on the page", async () => {
    vi.mocked(api.deleteAccount).mockRejectedValue(new ApiError(400, "Type your account email exactly to confirm."));
    const user = await openDeleteForm();

    await user.type(screen.getByLabelText(/Type your email/), "me@example.com");
    await user.click(screen.getByRole("button", { name: "Delete everything" }));

    expect(await screen.findByText(/Type your account email exactly/)).toBeInTheDocument();
    expect(goTo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete everything" })).toBeEnabled();
  });
});

describe("signed-out visitors", () => {
  it("are sent to the landing page", async () => {
    vi.mocked(api.me).mockRejectedValue(new ApiError(401, "unauthorized"));
    render(<DashboardPage />);
    await waitFor(() => expect(goTo).toHaveBeenCalledWith("/"));
  });

  it("see the key import and moving-out sections on the landing page, no account needed", () => {
    render(<LandingPage />);
    expect(screen.getByText("Switching from your own updater?")).toBeInTheDocument();
    expect(screen.getByText(/Already on Sparkle:/)).toBeInTheDocument();
    expect(screen.getByText(/Hand-rolled updater:/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /switching to Railcast/i })).toHaveAttribute("href", "/migrate");
    expect(screen.getByText(/railcast init --app myapp --import-key/)).toBeInTheDocument();
    expect(screen.getByText("Never locked in")).toBeInTheDocument();
    expect(screen.getByText(/railcast export --app myapp/)).toBeInTheDocument();
    expect(screen.getByText(/railcast redirect --to/)).toBeInTheDocument();
    expect(api.me).not.toHaveBeenCalled();
  });
});

describe("switching guide (/migrate)", () => {
  it("walks through export, import, publish and moving installed copies, with the commands", () => {
    render(<MigratePage />);
    expect(screen.getByRole("heading", { level: 1, name: /Switching from your own updater/ })).toBeInTheDocument();
    for (const step of [
      "Export your signing key",
      "Create the app with that key",
      "Publish your current release",
      "Send installed copies to the new feed",
    ]) {
      expect(screen.getByRole("heading", { name: new RegExp(step) })).toBeInTheDocument();
    }
    expect(screen.getByText("./generate_keys -x sparkle_private_key")).toBeInTheDocument();
    expect(screen.getByText(/railcast init --app myapp --import-key sparkle_private_key/)).toBeInTheDocument();
    expect(screen.getByText(/railcast publish -f MyApp-1\.4\.0\.zip/)).toBeInTheDocument();
    // both ways of moving installed copies
    expect(screen.getByText(/You control the old feed URL/)).toBeInTheDocument();
    expect(screen.getByText(/You don't\./)).toBeInTheDocument();
  });

  it("covers a hand-rolled updater and the way back out", () => {
    render(<MigratePage />);
    expect(screen.getByRole("heading", { name: /Hand-rolled updater, not Sparkle\?/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Not locked in" })).toBeInTheDocument();
  });

  it("is linked from the dashboard's create-an-app step, with the import command", async () => {
    render(<DashboardPage />);
    expect(await screen.findByText(/Already shipping with Sparkle\? Import the key/)).toBeInTheDocument();
    expect(screen.getByText(/railcast init --app myapp --import-key sparkle_private_key --token/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /switching from your own updater/i })).toHaveAttribute("href", "/migrate");
  });
});
