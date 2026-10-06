"""Development entry point; source carrier is selected explicitly by PowerShell."""
import json
import os
import site
import sys

target = os.environ.get('NEXGENT_DSH_DEV_DEPS')
if target:
    # pip --target dependencies can contain required .pth files (PyWin32).
    site.addsitedir(target)

if '--check' in sys.argv[1:]:
    from deepseek_harness import DeepSeekHarness
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    import uvicorn
    from nexgent.kernel.dsh import DshKernel
    print(json.dumps(DshKernel().identity(), ensure_ascii=False, indent=2))
elif '--cli' in sys.argv[1:]:
    sys.argv.remove('--cli')
    from nexgent.cli import main
    main()
else:
    from nexgent.ui.app import main
    main()
