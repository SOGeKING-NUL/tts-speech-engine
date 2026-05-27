/**
 * MicButton — animated microphone button with distinct visual states.
 *
 * States: ready | recording | processing | speaking
 */
export default function MicButton({ status = "ready", onClick, disabled }) {
  const icon = () => {
    switch (status) {
      case "recording":
        // Stop square
        return (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        );
      case "processing":
        // Spinning dots
        return (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="2.5" />
            <circle cx="12" cy="4" r="1.5" opacity=".4" />
            <circle cx="19" cy="8" r="1.5" opacity=".55" />
            <circle cx="19" cy="16" r="1.5" opacity=".7" />
            <circle cx="12" cy="20" r="1.5" opacity=".85" />
            <circle cx="5" cy="16" r="1.5" opacity=".7" />
            <circle cx="5" cy="8" r="1.5" opacity=".55" />
          </svg>
        );
      case "speaking":
        // Pause bars
        return (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1.5" />
            <rect x="14" y="5" width="4" height="14" rx="1.5" />
          </svg>
        );
      default:
        // Microphone
        return (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
          </svg>
        );
    }
  };

  const ariaLabel = {
    ready: "Start recording",
    recording: "Stop recording",
    processing: "Processing…",
    speaking: "Interrupt",
  }[status];

  return (
    <button
      id="mic-button"
      className={`mic-button ${status}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {icon()}
    </button>
  );
}
