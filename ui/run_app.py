"""Entry point for the packaged exe, which can't use `python -m`."""
import sys

from gemini_code_ui.__main__ import main

sys.exit(main())
