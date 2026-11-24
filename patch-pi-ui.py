from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path
import shutil
import tempfile

CHUNK = Path("dist/bundle/chunks/chunk-KSDI5FD4.js")
ORIGINAL = "5558c943edf1c00ca788788bc6b041d6a70a50ae7e646be2192ad399f1df7e34"
DIMMED = "f6ce8f2f9a362ab9491d50a4c9d782e6c823cd86e7c7a34516d005bace53d079"
CUSTOM = "3d4c3f70bdf94895dc23f60aab00fe730d73354ffa9e370a41016d42b2612125"
PREVIOUS_CUSTOM = "4eb0c487ad40b31cdac82f582aed1e5098cb3883c24d38cd0c0ee65f3a50e9a8"
COMMAND_COLORS = (
    ('theme.fg("toolTitle",`${prompt} ${commandDisplay}`)', 'theme.fg("muted",`${prompt} ${commandDisplay}`)'),
    ('theme.fg(this.colorKey,`$ ${this.command}`)', 'theme.fg("muted",`$ ${this.command}`)'),
)
COMMAND_PREVIEW = (
    (
        "function createShellRenderers(prompt){",
        "class ShellCommandPreview extends Text{"
        "render(width){const lines=super.render(width);"
        "if(this.commandExpanded||lines.length<=3)return lines;"
        "if(this.previewSource!==lines){this.previewSource=lines;"
        'this.previewLines=[...lines.slice(0,2),theme.fg("muted",truncateToWidth(" … click to expand",width))]} '
        "return this.previewLines}}function createShellRenderers(prompt){",
    ),
    (
        'let text=context.lastComponent??new Text("",0,0);return text.setText(formatShellCall(args,prompt)),text',
        'let text=context.lastComponent??new ShellCommandPreview("",0,0);'
        'return text.commandExpanded=context.expanded,text.setText(formatShellCall(args,prompt)),text',
    ),
    (
        'super(),this.command=command,this.colorKey=excludeFromContext?',
        'super(),this.command=command,this.commandUi=ui,this.colorKey=excludeFromContext?',
    ),
    (
        'let header=new Text(theme.fg("muted",`$ ${this.command}`),this.outputPad,0);if(this.contentContainer.addChild(header),',
        'let header=new ShellCommandPreview(theme.fg("muted",`$ ${this.command}`),this.outputPad,0);'
        'header.commandExpanded=this.expanded;'
        'if(this.contentContainer.addChild(new MouseRegion(header,event=>{'
        'if(event.type!=="click"||event.button!=="left")return;'
        'this.setExpanded(!this.expanded),this.commandUi.requestRender();return {handled:!0}})),',
    ),
)
REPLACEMENTS = (
    (
        'new Markdown(this.text,this.outputPad,1,this.markdownTheme,{color:content=>theme.fg("userMessageText",content),bgColor:content=>theme.bg("userMessageBg",content)}',
        'new Markdown(this.text,2,0,this.markdownTheme,{color:content=>theme.fg("userMessageText",content),bgColor:content=>theme.bg("userMessageBg",content.startsWith(" ")?theme.fg("accent","▎")+content.slice(1):content)}',
    ),
    (
        'this.contentBox=new Box(1,1,text=>theme.bg("toolPendingBg",text)),this.contentText=new Text("",1,1,text=>theme.bg("toolPendingBg",text))',
        'this.contentBox=new Box(1,0,text=>theme.bg("toolPendingBg",text)),this.contentText=new Text("",1,0,text=>theme.bg("toolPendingBg",text))',
    ),
    ('this.box=new Box(1,1,t=>theme.bg("customMessageBg",t))', 'this.box=new Box(1,0)'),
    (
        'let bgFn=this.isPartial?text=>theme.bg("toolPendingBg",text):this.result?.isError?text=>theme.bg("toolErrorBg",text):text=>theme.bg("toolSuccessBg",text),hasContent=!1;',
        'let railColor=this.result?.isError?"error":this.isPartial?"warning":"muted",bgFn=text=>text.startsWith(" ")?theme.fg(railColor,"┊")+text.slice(1):text,showResult=this.expanded||this.isPartial||this.result?.isError||this.getRenderShell()==="self",hasContent=!1;',
    ),
    (
        'renderContainer.setBgFn(bgFn),renderContainer.setPaddingX(this.outputPad)',
        'renderContainer.setBgFn(bgFn),renderContainer.setPaddingX(2)',
    ),
    (
        'if(this.result){let resultRenderer=this.getResultRenderer();',
        'if(this.result&&showResult){let resultRenderer=this.getResultRenderer();',
    ),
    (
        'this.contentText.setPaddingX(this.outputPad),this.contentText.setText(this.formatToolExecution())',
        'this.contentText.setPaddingX(2),this.contentText.setText(showResult?this.formatToolExecution():formatToolCallWithArgs(this.toolName,this.args,theme,!1))',
    ),
    ('theme.fg("toolTitle",theme.bold(`${prompt} ${commandDisplay}`))', 'theme.fg("toolTitle",`${prompt} ${commandDisplay}`)'),
    ('theme.fg(this.colorKey,theme.bold(`$ ${this.command}`))', 'theme.fg(this.colorKey,`$ ${this.command}`)'),
    *COMMAND_COLORS,
    *COMMAND_PREVIEW,
)
BUILD_STEPS = {
    ORIGINAL: 0,
    PREVIOUS_CUSTOM: len(REPLACEMENTS) - len(COMMAND_PREVIEW) - len(COMMAND_COLORS),
    DIMMED: len(REPLACEMENTS) - len(COMMAND_PREVIEW),
    CUSTOM: len(REPLACEMENTS),
}


TUI_CHUNK = Path("dist/bundle/chunks/chunk-X26YOAEH.js")
TUI_ORIGINAL = "1dc7029d526f9d5e81429c9c26a691f7777f2062dcf1df06d1b6a99127fd4425"
TUI_CUSTOM = "bead252fef335d14c34e71d2bfc3aa544d5fd683be28502fbe53c4787c0340ff"
FOCUS_REPLACEMENTS = (
    ("showHardwareCursor=!1;clearOnShrink", "showHardwareCursor=!1;terminalFocused=!0;clearOnShrink"),
    (r'this.afterTerminalStart(),this.terminal.hideCursor()',
     r'this.afterTerminalStart(),this.terminal.hideCursor(),this.terminal.write("\x1B[?1004h")'),
    (r'this.beforeTerminalStop(options),this.terminal.showCursor()',
     r'this.terminal.write("\x1B[?1004l"),this.beforeTerminalStop(options),this.terminal.showCursor()'),
    (r'getExitRestorePrefix(){return`${this.terminalColorSchemeNotificationsEnabled?',
     r'getExitRestorePrefix(){return`\x1B[?1004l${this.terminalColorSchemeNotificationsEnabled?'),
    ("handleTerminalInput(data){if(this.consumeTerminalColorResponse(data)",
     r'handleTerminalInput(data){const hasFocus=data==="\x1B[I",isFocusReport=hasFocus||data==="\x1B[O";'
     "if(isFocusReport&&this.terminalFocused!==hasFocus){this.terminalFocused=hasFocus;"
     "if(!hasFocus)this.terminal.hideCursor();this.requestRender()}"
     "if(this.consumeTerminalColorResponse(data)"),
    ("data=current}if(this.consumeCellSizeResponse(data))", "data=current}if(isFocusReport||this.consumeCellSizeResponse(data))"),
    (r'buffer+=this.getShowHardwareCursor()?"\x1B[?25h"', r'buffer+=this.terminalFocused&&this.getShowHardwareCursor()?"\x1B[?25h"'),
    ("this.getShowHardwareCursor()?this.terminal.showCursor()", "this.terminalFocused&&this.getShowHardwareCursor()?this.terminal.showCursor()"),
    (r'\x1B[?1002h\x1B[?1004h\x1B[?1006h', r'\x1B[?1002h\x1B[?1006h'),
    (r'\x1B[?1003h\x1B[?1004h\x1B[?1006h', r'\x1B[?1003h\x1B[?1006h'),
    (r'\x1B[?1006l\x1B[?1004l\x1B[?1003l', r'\x1B[?1006l\x1B[?1003l'),
)


def plan_patch(parser, bundle, replacements, steps_by_hash, target, undo):
    if not bundle.is_file():
        parser.error(f"Pi 1.6.0 bundle not found at {bundle}.")
    original = bundle.read_bytes()
    current = sha256(original).hexdigest()
    if current == target:
        return None
    if current not in steps_by_hash:
        parser.error(f"Unexpected Pi bundle checksum at {bundle}. This patch targets the saved Pi 1.6.0 build.")

    steps = steps_by_hash[current]
    updated = original
    pairs = [(after, before) for before, after in reversed(replacements[:steps])] if undo else replacements[steps:]
    for before, after in pairs:
        if updated.count(before.encode()) != 1:
            parser.error(f"A UI patch anchor was missing or ambiguous in {bundle.name}.")
        updated = updated.replace(before.encode(), after.encode())
    if sha256(updated).hexdigest() != target:
        parser.error(f"The patched bundle did not match the expected checksum for {bundle.name}.")
    return bundle, original, updated


def replace_bundle(parser, bundle, original, updated):
    with tempfile.NamedTemporaryFile(dir=bundle.parent, delete=False) as stream:
        staged = Path(stream.name)
        try:
            stream.write(updated)
            stream.close()
            shutil.copymode(bundle, staged)
            if bundle.read_bytes() != original:
                parser.error("The installed bundle changed while applying the patch.")
            staged.replace(bundle)
        finally:
            staged.unlink(missing_ok=True)


def main():
    parser = ArgumentParser(description="Apply or reverse the compact Pi 1.6.0 transcript patch.")
    parser.add_argument("--package-dir", type=Path, help="Pi npm package directory. Defaults to the package behind pi on PATH.")
    parser.add_argument("--undo", action="store_true", help="Restore the original bundle bytes.")
    args = parser.parse_args()
    package = args.package_dir
    if package is None:
        executable = shutil.which("pi")
        if not executable:
            parser.error("pi was not found on PATH. Supply --package-dir.")
        package = next((parent for parent in Path(executable).resolve().parents if (parent / CHUNK).is_file()), None)
        if package is None:
            parser.error("The expected Pi 1.6.0 bundle was not found. Supply --package-dir if needed.")
    patches = [
        plan_patch(parser, package / CHUNK, REPLACEMENTS, BUILD_STEPS, ORIGINAL if args.undo else CUSTOM, args.undo),
        plan_patch(parser, package / TUI_CHUNK, FOCUS_REPLACEMENTS, {TUI_ORIGINAL: 0, TUI_CUSTOM: len(FOCUS_REPLACEMENTS)},
                   TUI_ORIGINAL if args.undo else TUI_CUSTOM, args.undo),
    ]
    if not any(patches):
        print("Pi already has the requested UI.")
        return
    for patch in patches:
        if patch:
            replace_bundle(parser, *patch)
    print("Restart Pi to load the updated UI.")


if __name__ == "__main__":
    main()
