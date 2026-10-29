// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebSocketHandle } from "../src/hooks/use-websocket";
import { ChatSidebar } from "../src/components/chat-sidebar";

const {
  createSessionMock,
  deleteSessionMock,
  fetchMessagesMock,
  fetchSessionsMock,
  saveMessageMock,
  updateSessionTitleMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  fetchMessagesMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  saveMessageMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  createSession: createSessionMock,
  deleteSession: deleteSessionMock,
  fetchMessages: fetchMessagesMock,
  fetchSessions: fetchSessionsMock,
  saveMessage: saveMessageMock,
  updateSessionTitle: updateSessionTitleMock,
  fetchImageModels: vi.fn(async () => ({ models: [] })),
  fetchVideoModels: vi.fn(async () => ({ models: [] })),
  fetchModels: vi.fn(async () => ({ models: [] })),
  fetchWorkspaceSkills: vi.fn(async () => ({ skills: [] })),
}));
vi.mock("../src/components/credits/tier-limit-toast", () => ({ useTierLimitToast: () => ({ showTierLimit: vi.fn() }) }));
vi.mock("../src/components/toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../src/hooks/use-breakpoint", () => ({ useBreakpoint: () => "desktop" }));

function createMockWs(): WebSocketHandle {
  return {
    connected: true,
    startRun: vi.fn((payload, onAck) => {
      // Simulate server ack
      onAck?.({
        type: "command.ack",
        action: "agent.run",
        payload: { runId: "run_123" },
      });
    }),
    cancelRun: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    registerRPC: vi.fn(() => () => {}),
    resumeCanvas: vi.fn((_canvasId, ack) => ack?.({ type: "command.ack", action: "canvas.resume", payload: {} })),
  };
}

describe("ChatSidebar", () => {
  let mockWs: WebSocketHandle;

  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    mockWs = createMockWs();
    createSessionMock.mockReset();
    createSessionMock.mockResolvedValue({
      session: {
        id: "session-created",
        title: "New Chat",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    });
    deleteSessionMock.mockReset();
    fetchMessagesMock.mockReset();
    fetchMessagesMock.mockResolvedValue({ messages: [] });
    fetchSessionsMock.mockReset();
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        {
          id: "session-real",
          title: "Existing Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    });
    saveMessageMock.mockReset();
    saveMessageMock.mockResolvedValue(undefined);
    updateSessionTitleMock.mockReset();
    updateSessionTitleMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("starts runs via WebSocket with the active real session id", async () => {
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    const input = await screen.findByPlaceholderText(
      /start with an idea/i,
    );
    await userEvent.type(input, "hello loom{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-real",
          conversationId: "canvas-1",
          prompt: "hello loom",
          canvasId: "canvas-1",
        }),
        expect.any(Function),
      ),
    );
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-canvas-1",
      }),
      expect.anything(),
    );
  });

  it("passes the selected canvas image and file ID into the original Agent run", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUB_LOCAL_RUNTIME", "1");
    render(<ChatSidebar accessToken="local-fixture" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} selectedCanvasElements={[{ id: "selected-image", type: "image", fileId: "file-1", dataUrl: "data:image/png;base64,fixture", x: 0, y: 0, width: 80, height: 60 }]} />);
    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "make the selected image warm{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledWith(expect.objectContaining({
      canvasId: "canvas-1", sessionId: "session-real",
      attachments: [expect.objectContaining({ assetId: "selected-image", fileId: "file-1", source: "canvas-ref" })],
    }), expect.any(Function)));
  });
});
