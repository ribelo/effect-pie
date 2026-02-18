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
- `xdotool` available for X11 typing

## Commands

Register and monitor PTT shortcut events:

```bash
bun run cli -- ptt-portal --shortcut "<Ctrl><Super>space" --id push_to_talk --description "effect-pi push-to-talk"
```

Type text into the currently focused field (backend auto-detected):

```bash
bun run cli -- type --text "hello from effect-pi"
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
- No STT pipeline integration yet; this is only trigger/input feasibility.
