# Linux PTT + Text Injection Spike

## Goal

Validate two pieces independently before STT wiring:

- Capture a global push-to-talk shortcut through `org.freedesktop.portal.GlobalShortcuts`
- Type text into the focused app with automatic backend selection:
  - Wayland session -> `wtype`
  - X11 session -> `xdotool`
  - If primary backend fails due missing tool/display, it tries the alternate backend when available

## Requirements

- Linux graphical session (`XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, or `DISPLAY`)
- `xdg-desktop-portal` running for PTT portal probing
- Desktop portal backend with GlobalShortcuts support (varies by desktop/version)
- `busctl` available in `PATH`
- `wtype` available for Wayland typing
- `wl-copy` optional for clipboard edge-case mode on Wayland
- `wl-paste` optional for restoring previous clipboard after paste
- `xdotool` available for X11 typing

## Commands

Register and monitor PTT shortcut events:

```bash
bun run cli -- ptt-portal --shortcut "<Ctrl><Super>space" --id push_to_talk --description "pie push-to-talk"
```

Type text into the currently focused field (backend auto-detected):

```bash
bun run cli -- type --text "hello from pie"
```

Wayland injection mode (optional):

```bash
# Default: auto (direct wtype, clipboard only for quote-heavy text)
PIE_WAYLAND_INJECTION_MODE=auto bun run cli -- type --text "don't break apostrophes"

# Force clipboard for all text
PIE_WAYLAND_INJECTION_MODE=clipboard bun run cli -- type --text "hello"

# Force direct wtype key typing
PIE_WAYLAND_INJECTION_MODE=direct bun run cli -- type --text "hello"
```

## Manual Validation

1. Start the portal probe command.
2. Accept the desktop portal prompt when shown.
3. Focus another app and press the shortcut.
4. Confirm portal monitor output includes `Member="Activated"` and `Member="Deactivated"`.
5. Focus a text field (for example Slack, terminal, browser input).
6. Run the `type` command and confirm text appears.
7. Confirm CLI output reports backend/session, for example `wtype (wayland)` or `xdotool (x11)`.

## Known Limits

- GlobalShortcuts availability depends on portal backend and desktop version.
- The spike currently uses raw `busctl monitor` output for activation visibility.
- `wtype` and `xdotool` both depend on having a live graphical session and focused input field.
- STT integration is now available via `ptt-transcribe` and `ptt-translate`; this document focuses only on portal/input wiring checks.
