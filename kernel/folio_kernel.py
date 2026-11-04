#!/usr/bin/env python3
"""Folio kernel bridge.

Speaks newline-delimited JSON on stdin/stdout and manages one Jupyter kernel per
document, so code cells can run incrementally (like a notebook) while you edit.

Requests  (stdin):  {"op": "execute"|"interrupt"|"restart"|"shutdown", "req": str, "doc": str, "cwd": str, "code": str}
Responses (stdout): {"req": str, "type": "stream"|"display"|"error"|"clear"|"status"|"done", ...}

Requires: jupyter_client, ipykernel (pip install jupyter_client ipykernel).
"""
import json
import queue
import sys
import threading

_out_lock = threading.Lock()


def emit(msg):
    line = json.dumps(msg, ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


try:
    from jupyter_client.manager import KernelManager
except Exception as exc:  # pragma: no cover - reported to the UI
    KernelManager = None
    _IMPORT_ERROR = f"{type(exc).__name__}: {exc}"
else:
    _IMPORT_ERROR = None

SETUP_CODE = """
try:
    get_ipython().run_line_magic('config', "InlineBackend.figure_format = 'retina'")
except Exception:
    pass
"""


class DocKernel:
    def __init__(self, doc, cwd):
        self.doc = doc
        self.cwd = cwd
        self.queue = queue.Queue()
        self.km = None
        self.kc = None
        self.thread = threading.Thread(target=self._worker, daemon=True)
        self.thread.start()

    # -- lifecycle -------------------------------------------------------
    def _start(self, req):
        emit({"req": req, "type": "status", "state": "starting"})
        self.km = KernelManager(kernel_name="python3")
        self.km.start_kernel(cwd=self.cwd or None)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        self._run(SETUP_CODE, None)

    def shutdown(self):
        try:
            if self.kc:
                self.kc.stop_channels()
            if self.km:
                self.km.shutdown_kernel(now=True)
        except Exception:
            pass
        self.km = self.kc = None

    def interrupt(self):
        if self.km:
            self.km.interrupt_kernel()

    def restart(self, req):
        self.shutdown()
        emit({"req": req, "type": "status", "state": "restarted"})

    # -- execution -------------------------------------------------------
    def submit(self, req, code, cwd):
        if cwd:
            self.cwd = cwd
        self.queue.put((req, code))

    def _worker(self):
        while True:
            req, code = self.queue.get()
            try:
                if self.kc is None:
                    self._start(req)
                emit({"req": req, "type": "status", "state": "busy"})
                ok = self._run(code, req)
                emit({"req": req, "type": "done", "ok": ok})
            except Exception as exc:
                emit({"req": req, "type": "done", "ok": False, "error": f"{type(exc).__name__}: {exc}"})

    def _run(self, code, req):
        msg_id = self.kc.execute(code, store_history=req is not None, allow_stdin=False)
        ok = True
        while True:
            try:
                msg = self.kc.get_iopub_msg(timeout=3600)
            except queue.Empty:
                return False
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            t = msg["msg_type"]
            c = msg["content"]
            if req is None:
                if t == "status" and c.get("execution_state") == "idle":
                    return True
                continue
            if t == "stream":
                emit({"req": req, "type": "stream", "name": c.get("name", "stdout"), "text": c.get("text", "")})
            elif t in ("display_data", "execute_result", "update_display_data"):
                data = {k: (v if isinstance(v, str) else json.dumps(v)) for k, v in c.get("data", {}).items()}
                emit({"req": req, "type": "display", "data": data})
            elif t == "error":
                ok = False
                emit({"req": req, "type": "error", "ename": c.get("ename", ""), "evalue": c.get("evalue", ""),
                      "traceback": c.get("traceback", [])})
            elif t == "clear_output":
                emit({"req": req, "type": "clear"})
            elif t == "status" and c.get("execution_state") == "idle":
                return ok


def main():
    kernels = {}
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        op, req, doc = msg.get("op"), msg.get("req", ""), msg.get("doc", "")
        if KernelManager is None:
            emit({"req": req, "type": "done", "ok": False,
                  "error": f"jupyter_client is not available in {sys.executable}: {_IMPORT_ERROR}. "
                           f"Install it with: {sys.executable} -m pip install jupyter_client ipykernel"})
            continue
        if op == "execute":
            k = kernels.get(doc)
            if k is None:
                k = kernels[doc] = DocKernel(doc, msg.get("cwd"))
            k.submit(req, msg.get("code", ""), msg.get("cwd"))
        elif op == "interrupt":
            if doc in kernels:
                kernels[doc].interrupt()
        elif op == "restart":
            if doc in kernels:
                kernels[doc].restart(req)
        elif op == "shutdown":
            for k in kernels.values():
                k.shutdown()
            break
    for k in kernels.values():
        k.shutdown()


if __name__ == "__main__":
    main()
