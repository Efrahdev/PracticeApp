// Delete attempts recorded by mistake (one, several, or a whole sitting), with Undo.
// Uses the standard confirmation (Delete -> Confirm); the toast afterwards offers Undo, which puts the exact rows back.
import { api } from "./api";
import { refresh } from "./store";
import { askConfirm, toast } from "./ui";

export async function deleteAttempts(
  what: { ids: string[]; reopen?: boolean } | { session_id: string },
  opts: { title: string; message: string; onChange?: () => void; confirmed?: boolean },
): Promise<boolean> {
  if (!opts.confirmed && !(await askConfirm({ title: opts.title, message: opts.message, confirmLabel: "Delete", danger: true }))) return false;
  try {
    const r = await api<{ deleted: number; payload: unknown }>("POST", "/api/attempts/delete", what);
    await refresh();
    opts.onChange?.();
    toast(r.deleted === 1 ? "Attempt deleted" : `${r.deleted} attempts deleted`, "ok", {
      label: "Undo",
      run: async () => {
        try {
          await api("POST", "/api/attempts/restore", { payload: r.payload });
          await refresh();
          opts.onChange?.();
          toast("Restored");
        } catch (e) { toast((e as Error).message, "error"); }
      },
    });
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}
