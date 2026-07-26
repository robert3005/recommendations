/**
 * The post editor's pin-tap channel (spec/src/posts.md §Authoring): while an
 * editor is registered, tapping a projected pin inserts a mention at the
 * cursor instead of selecting the place. The editor registers on mount; the
 * canvas emits. Not a store — nothing renders from this, it is a call path.
 */
export interface EditorBridge {
  /** Register the mounted editor's handler; returns its unregister. */
  register(onPinTap: (placeId: string) => void): () => void;
  emitPinTap(placeId: string): void;
}

function createEditorBridge(): EditorBridge & { isRegistered(): boolean } {
  let handler: ((placeId: string) => void) | null = null;
  return {
    register(onPinTap) {
      // Last registration wins — at most one editor is mounted at a time.
      handler = onPinTap;
      return () => {
        if (handler === onPinTap) handler = null;
      };
    },
    emitPinTap(placeId) {
      handler?.(placeId);
    },
    isRegistered() {
      return handler !== null;
    },
  };
}

export const editorBridge = createEditorBridge();
