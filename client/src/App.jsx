import { useState } from "react";
import VoiceChat from "./components/VoiceChat";

function App() {
  const [launched, setLaunched] = useState(false);

  if (!launched) {
    return (
      <div className="app" style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", flexDirection: "column" }}>
        <h1>Welcome to Voice AI</h1>
        <p style={{ marginBottom: "24px", color: "#666" }}>Your intelligent voice assistant is ready.</p>
        <button 
          onClick={() => setLaunched(true)}
          style={{ padding: "16px 32px", fontSize: "18px", borderRadius: "32px", cursor: "pointer", background: "var(--accent, #007AFF)", color: "white", border: "none", fontWeight: "bold", boxShadow: "0 4px 12px rgba(0, 122, 255, 0.3)" }}
        >
          Launch Client
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <VoiceChat />
    </div>
  );
}

export default App;
