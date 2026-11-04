"""Serve the production gateway for browser tests; browser routes supply fixtures."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from canaveral.dashboard import server

server(("127.0.0.1", 18766), "http://127.0.0.1:18765").serve_forever()
