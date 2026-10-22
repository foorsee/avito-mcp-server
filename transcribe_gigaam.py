#!/usr/bin/env python3
"""
GigaAM Russian Speech Recognition Bridge for Avito MCP Server.
Uses Sber GigaAM (salute-developers/GigaAM) to transcribe Russian speech / voice messages.
"""

import sys
import os
import json
import argparse

# Ensure UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

def get_device():
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"

_cached_model = None
_cached_model_name = None

def get_model(model_name="v2_ctc"):
    global _cached_model, _cached_model_name
    if _cached_model is not None and _cached_model_name == model_name:
        return _cached_model
    import gigaam
    _cached_model = gigaam.load_model(model_name)
    _cached_model_name = model_name
    return _cached_model

def transcribe_file(audio_path, model_name="v2_ctc"):
    if not os.path.isfile(audio_path):
        return {"success": False, "error": f"Audio file not found: {audio_path}"}
    
    try:
        model = get_model(model_name)
        result = model.transcribe(audio_path)
        text = result.text.strip() if hasattr(result, "text") else str(result).strip()
        return {
            "success": True,
            "text": text,
            "model": model_name,
            "file": audio_path
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "file": audio_path
        }

def run_daemon(model_name="v2_ctc"):
    # Preload model
    sys.stderr.write(f"[gigaam-daemon] preloading model '{model_name}' on {get_device()}...\n")
    sys.stderr.flush()
    get_model(model_name)
    sys.stderr.write("[gigaam-daemon] ready\n")
    sys.stderr.flush()
    print(json.dumps({"status": "ready", "model": model_name}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            req = {"path": line}

        cmd = req.get("cmd")
        if cmd == "ping":
            print(json.dumps({"status": "pong"}), flush=True)
            continue
        if cmd == "exit":
            break

        path = req.get("path")
        m_name = req.get("model", model_name)
        res = transcribe_file(path, model_name=m_name)
        print(json.dumps(res, ensure_ascii=False), flush=True)

def main():
    parser = argparse.ArgumentParser(description="GigaAM Voice Recognition CLI")
    parser.add_argument("audio", nargs="?", help="Path to audio file (wav, ogg, mp3, etc.)")
    parser.add_argument("--model", default="v2_ctc", help="Model name (v2_ctc, v3_ctc, etc.)")
    parser.add_argument("--daemon", action="store_true", help="Run as JSON-line daemon")
    parser.add_argument("--check", action="store_true", help="Check environment and readiness")

    args = parser.parse_args()

    if args.check:
        try:
            import torch
            import gigaam
            info = {
                "success": True,
                "torch_version": torch.__version__,
                "cuda_available": torch.cuda.is_available(),
                "device": get_device(),
                "gigaam_version": getattr(gigaam, "__version__", "unknown")
            }
            if torch.cuda.is_available():
                info["gpu_name"] = torch.cuda.get_device_name(0)
            print(json.dumps(info, ensure_ascii=False, indent=2))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False, indent=2))
        return

    if args.daemon:
        run_daemon(model_name=args.model)
        return

    if not args.audio:
        parser.print_help()
        sys.exit(1)

    res = transcribe_file(args.audio, model_name=args.model)
    print(json.dumps(res, ensure_ascii=False))
    if not res.get("success"):
        sys.exit(1)

if __name__ == "__main__":
    main()
