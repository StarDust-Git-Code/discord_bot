import { useState, useRef, useEffect } from "react";
import "./App.css";

interface Message {
  role: "user" | "assistant" | "error";
  text: string;
}

const EXAMPLES = [
  "list my servers",
  "list channels in my first server",
  "create a text channel called announcements",
  "create a voice channel called Gaming",
  "create a category called Community",
  "rename the channel general to welcome",
];

function App() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "I'm your Discord server manager powered by Gemini 3.1 Flash Lite. Tell me what to do — create channels, rename them, send messages, and more." },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(cmd?: string) {
    const text = (cmd || input).trim();
    if (!text || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setLoading(true);

    try {
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: text }),
      });
      const data = await res.json();
      setMessages((m) => [
        ...m,
        { role: res.ok ? "assistant" : "error", text: data.message || data.error || "Unknown error" },
      ]);
    } catch (err: any) {
      setMessages((m) => [...m, { role: "error", text: err.message }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header>
        <div className="header-content">
          <span className="logo">&#9881;</span>
          <div>
            <h1>Discord Commander</h1>
            <span className="subtitle">powered by Gemini 3.1 Flash Lite</span>
          </div>
        </div>
      </header>

      <main>
        <div className="chat">
          {messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              <div className="avatar">
                {msg.role === "user" ? "U" : msg.role === "error" ? "!" : "B"}
              </div>
              <div className="bubble">
                <pre>{msg.text}</pre>
              </div>
            </div>
          ))}
          {loading && (
            <div className="message assistant">
              <div className="avatar">B</div>
              <div className="bubble loading">
                <span className="dot-pulse"></span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <div className="examples">
        {EXAMPLES.map((ex, i) => (
          <button key={i} className="chip" onClick={() => handleSend(ex)} disabled={loading}>
            {ex}
          </button>
        ))}
      </div>

      <footer>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a command…"
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}

export default App;
