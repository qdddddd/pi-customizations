from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path
import json
import shutil
import tempfile

CHUNK = Path("dist/bundle/chunks/chunk-KSDI5FD4.js")
ORIGINAL = "5558c943edf1c00ca788788bc6b041d6a70a50ae7e646be2192ad399f1df7e34"
DIMMED = "f6ce8f2f9a362ab9491d50a4c9d782e6c823cd86e7c7a34516d005bace53d079"
COMMAND_COMPACT = "3d4c3f70bdf94895dc23f60aab00fe730d73354ffa9e370a41016d42b2612125"
THINKING_YELLOW = "0aba5b283d7c6418e120c78ae0c523ce5fb299da02d3d497eea0fb855fdf17de"
ORANGE_USER_BAR = "d65285128c128a561ea6f3559b6f536f859ebc67fdf3e460a18a3cb3b3b926f0"
PURPLE_USER_BAR = "ebd60ca712c60bfa599726f1277adf892da33543f9cfac0fa3b48a8993419cb0"
BORDER_MUTED = "e28058001fcffdeed2c4aef066853059489480626ec3a8ad42d5a489293c434f"
WRITE_COMPACT = "0a41fed9eac5c08d0c18bc7c2fc5c6103e9cbd4c716fbeeb38678ff68e2dc618"
CUSTOM = "8cd352ad374d534c76e6d259b06016b9ed0362d99964aa5ff5a0646b1e552bc3"
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
THINKING_COLORS = (
    (
        'theme.italic(theme.fg("thinkingText",this.hiddenThinkingLabel))',
        'theme.fg("thinkingText",this.hiddenThinkingLabel)',
    ),
    (
        'this.markdownTheme,{color:text=>theme.fg("thinkingText",text),italic:!0}',
        '{...this.markdownTheme,italic:text=>text},{color:text=>theme.fg("thinkingText",text)}',
    ),
)
THINKING_WEIGHT = (
    (
        '{...this.markdownTheme,italic:text=>text},{color:text=>theme.fg("thinkingText",text)}',
        '{...this.markdownTheme,italic:text=>text,bold:text=>text},{color:text=>theme.fg("thinkingText",text)}',
    ),
)
WRITE_PREVIEW = (
    (
        'function formatWriteCall(args,options,theme2,cache2,highlighter,cwd){'
        'let rawPath=str(args?.file_path??args?.path),fileContent=str(args?.content),',
        '''function writePreview(content) {
    let words = 0;
    let end = 0;
    for (const word of content.matchAll(/\\S+/g)) {
        if (++words > 100) return content.slice(0, end);
        end = word.index + word[0].length;
    }
    return content;
}
function formatWriteCall(rawPath,fileContent,wordClipped,options,theme2,cache2,highlighter,cwd){let ''',
    ),
    (
        'totalLines=lines.length,maxLines=options.expanded?lines.length:10,displayLines=lines.slice(0,maxLines),'
        'remaining=lines.length-maxLines;',
        'maxLines=options.expanded?lines.length:10,displayLines=lines.slice(0,maxLines),'
        'clipped=wordClipped||lines.length>maxLines;',
    ),
    (
        'remaining>0&&(text+=`${theme2.fg("muted",`\n... (${remaining} more lines, ${totalLines} total,`)} '
        '${keyHint("app.tools.expand","to expand")}${theme2.fg("muted",")")}`)',
        '''clipped&&(text+=`\\n${theme2.fg("muted","… click")}${
            keyText("app.tools.expand")
                ? ` ${theme2.fg("muted","or")} ${keyHint("app.tools.expand","to expand")}`
                : theme2.fg("muted"," to expand")
        }`)''',
    ),
    (
        'fileContent=str(renderArgs?.content),component=context.lastComponent??new WriteCallRenderComponent;',
        '''fullContent=str(renderArgs?.content),
    fileContent=fullContent===null||context.expanded?fullContent:writePreview(fullContent),
    component=context.lastComponent??new WriteCallRenderComponent;''',
    ),
    (
        'formatWriteCall(renderArgs,{expanded:context.expanded,isPartial:context.isPartial},',
        'formatWriteCall(rawPath,fileContent,fileContent!==fullContent,{expanded:context.expanded},',
    ),
)
PATH_COLOR_CALLS = (
    (
        'function formatReadCall(args,theme2,cwd){let pathDisplay=renderToolPath(str(args?.file_path??args?.path),theme2,cwd);',
        'function formatReadCall(args,theme2,cwd){let pathDisplay=renderToolPath(str(args?.file_path??args?.path),theme2,cwd,{aqua:true});',
    ),
    (
        'pathDisplay=renderToolPath(rawPath,theme2,cwd),text=`${theme2.fg("toolTitle",theme2.bold("write"))}',
        'pathDisplay=renderToolPath(rawPath,theme2,cwd,{aqua:true}),text=`${theme2.fg("toolTitle",theme2.bold("write"))}',
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
    *THINKING_COLORS,
    *THINKING_WEIGHT,
    ('theme.fg("accent","▎")', 'theme.fg("border","▎")'),
    (
        'let railColor=this.result?.isError?"error":this.isPartial?"warning":"muted",bgFn=',
        'let railColor=this.result?.isError?"error":this.isPartial?"warning":"borderMuted",bgFn=',
    ),
    *WRITE_PREVIEW,
    *PATH_COLOR_CALLS,
)
ORANGE_USER_BAR_STEPS = len(REPLACEMENTS) - len(WRITE_PREVIEW) - len(PATH_COLOR_CALLS) - 2
BUILD_STEPS = {
    ORIGINAL: 0,
    PREVIOUS_CUSTOM: ORANGE_USER_BAR_STEPS - len(COMMAND_COLORS + COMMAND_PREVIEW + THINKING_COLORS + THINKING_WEIGHT),
    DIMMED: ORANGE_USER_BAR_STEPS - len(COMMAND_PREVIEW + THINKING_COLORS + THINKING_WEIGHT),
    COMMAND_COMPACT: ORANGE_USER_BAR_STEPS - len(THINKING_COLORS + THINKING_WEIGHT),
    THINKING_YELLOW: ORANGE_USER_BAR_STEPS - len(THINKING_WEIGHT),
    ORANGE_USER_BAR: ORANGE_USER_BAR_STEPS,
    PURPLE_USER_BAR: ORANGE_USER_BAR_STEPS + 1,
    BORDER_MUTED: ORANGE_USER_BAR_STEPS + 2,
    WRITE_COMPACT: len(REPLACEMENTS) - len(PATH_COLOR_CALLS),
    CUSTOM: len(REPLACEMENTS),
}

PATH_CHUNK = Path("dist/bundle/chunks/chunk-XGGZYFNG.js")
PATH_ORIGINAL = "e79117ae45c426c03f79c5a7495e9b6b09341d50cf8743835d021442491939a8"
PATH_CUSTOM = "d2541d5d1dd48b113531e465dd1184c712fdfa07a2858d46f1ae3f38378478f8"
PATH_REPLACEMENTS = (
    (
        'let value=rawPath||options?.emptyFallback;return value?linkPath(theme.fg("accent",shortenPath(value)),value,cwd)',
        '''let value=rawPath||options?.emptyFallback;
    // Both Gruvbox themes map bashMode to their aqua palette entry.
    const color = options?.aqua && (theme.name === "gruvbox" || theme.name === "gruvbox-light") ? "bashMode" : "accent";
    return value?linkPath(theme.fg(color,shortenPath(value)),value,cwd)''',
    ),
)


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


# Each supported npm build maps its three bundles to (chunk, replacements, checksum -> applied steps, original, custom).
# 1.6.0 also accepts the partially patched checksums of earlier script revisions.
BUILDS = {
    "1.6.0": (
        (CHUNK, REPLACEMENTS, BUILD_STEPS, ORIGINAL, CUSTOM),
        (PATH_CHUNK, PATH_REPLACEMENTS, {PATH_ORIGINAL: 0, PATH_CUSTOM: len(PATH_REPLACEMENTS)}, PATH_ORIGINAL, PATH_CUSTOM),
        (TUI_CHUNK, FOCUS_REPLACEMENTS, {TUI_ORIGINAL: 0, TUI_CUSTOM: len(FOCUS_REPLACEMENTS)}, TUI_ORIGINAL, TUI_CUSTOM),
    ),
}


def add_build(version, *bundles):
    BUILDS[version] = tuple(
        (Path("dist/bundle/chunks") / chunk, replacements, {original: 0, custom: len(replacements)}, original, custom)
        for chunk, replacements, original, custom in bundles
    )


add_build(
    "1.6.1",
    ("chunk-ORY5MLDF.js", REPLACEMENTS,
     "969756eea20f331cfde2aed70ecd1deb4c78df5ac678715180d0ce4a5d65093e",
     "575e02c9d00e46961a915704c0a932a1db09a7431062a4301785bf77b6f8548b"),
    ("chunk-ESCXDUHA.js", PATH_REPLACEMENTS,
     "02f71c706a895d8884ddba80a3769b1882eecfbae3055c7537da3e8e0be8f02c",
     "30d3c3776e09b9419aa234065c6cc7af2070b4ef053786df566bf80a05e1f376"),
    ("chunk-GH2VPQ2P.js", FOCUS_REPLACEMENTS,
     "e2b79bd7410b1b9e99e64dbdbe8d8c951e2eb91f22dd616b89a8d780221937ed",
     "e77be136641ac83cb69572f9dc0868aa41d3bcc538c648849ddbf6fff1c32320"),
)


def plan_patch(parser, bundle, replacements, steps_by_hash, target, undo):
    if not bundle.is_file():
        parser.error(f"Pi bundle not found at {bundle}.")
    original = bundle.read_bytes()
    current = sha256(original).hexdigest()
    if current == target:
        return None
    if current not in steps_by_hash:
        parser.error(f"Unexpected Pi bundle checksum at {bundle}. This patch targets the saved Pi npm builds.")

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
    parser = ArgumentParser(description="Apply or reverse the compact Pi transcript patch.")
    parser.add_argument("--package-dir", type=Path, help="Pi npm package directory. Defaults to the package behind pi on PATH.")
    parser.add_argument("--undo", action="store_true", help="Restore the original bundle bytes.")
    args = parser.parse_args()
    package = args.package_dir
    if package is None:
        executable = shutil.which("pi")
        if not executable:
            parser.error("pi was not found on PATH. Supply --package-dir.")
        package = next(
            (parent for parent in Path(executable).resolve().parents if (parent / "dist/bundle/chunks").is_dir()), None
        )
        if package is None:
            parser.error("The Pi npm package was not found. Supply --package-dir if needed.")
    version = json.loads((package / "package.json").read_text())["version"]
    if version not in BUILDS:
        parser.error(f"Pi {version} is not supported. Supported builds: {', '.join(BUILDS)}.")
    patches = [
        plan_patch(parser, package / chunk, replacements, steps, original if args.undo else custom, args.undo)
        for chunk, replacements, steps, original, custom in BUILDS[version]
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
