/**
 * Per-profile e-conomic client registry.
 *
 * Tools target an account via an optional `profile` argument, defaulting to the
 * session's active profile. The active profile starts at the registry's default
 * and can be changed at runtime with `use()` (exposed as the
 * `economic_use_profile` tool). Clients are created lazily and cached per
 * profile, so switching accounts mid-session is cheap.
 */

import type { ProfileInfo, ProfileRegistry } from "./config.js";
import { EconomicClient } from "./economicClient.js";

export class ClientRegistry {
  private readonly clients = new Map<string, EconomicClient>();
  private active: string;

  constructor(private readonly profiles: ProfileRegistry) {
    this.active = profiles.defaultProfile;
  }

  /** The profile used when a tool call omits `profile`. */
  get activeProfile(): string {
    return this.active;
  }

  get defaultProfile(): string {
    return this.profiles.defaultProfile;
  }

  get names(): string[] {
    return this.profiles.names;
  }

  has(name: string): boolean {
    return this.profiles.has(name);
  }

  /**
   * Resolve the client for the given profile (or the active one). Throws with a
   * helpful message if the profile is unknown or missing credentials.
   */
  resolve(profile?: string): EconomicClient {
    const name = profile?.trim() || this.active;
    let client = this.clients.get(name);
    if (!client) {
      client = new EconomicClient(this.profiles.get(name));
      this.clients.set(name, client);
    }
    return client;
  }

  /** Change the active profile for subsequent calls that omit `profile`. */
  use(name: string): string {
    const target = name?.trim();
    if (!target) throw new Error("A profile name is required.");
    // Validate that the profile exists and resolves before switching.
    this.profiles.get(target);
    this.active = target;
    return this.active;
  }

  /** Non-secret metadata for every configured profile, marking the active one. */
  describe(): Array<ProfileInfo & { active: boolean }> {
    return this.profiles.describe().map((info) => ({
      ...info,
      active: info.name === this.active,
    }));
  }
}
