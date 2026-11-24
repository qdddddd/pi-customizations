from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path
import shutil
import tempfile

CHUNK = Path("dist/bundle/chunks/chunk-KSDI5FD4.js")
ORIGINAL = "5558c943edf1c00ca788788bc6b041d6a70a50ae7e646be2192ad399f1df7e34"
CUSTOM = "4eb0c487ad40b31cdac82f582aed1e5098cb3883c24d38cd0c0ee65f3a50e9a8"
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
)


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
    bundle = package / CHUNK
    if not bundle.is_file():
        parser.error(f"Pi 1.6.0 bundle not found at {bundle}.")

    source, target = (CUSTOM, ORIGINAL) if args.undo else (ORIGINAL, CUSTOM)
    original = bundle.read_bytes()
    current = sha256(original).hexdigest()
    if current == target:
        print("Pi already has the requested UI.")
        return
    if current != source:
        parser.error(f"Unexpected Pi bundle checksum at {bundle}. This patch targets the saved Pi 1.6.0 build.")

    updated = original
    pairs = [(after, before) for before, after in reversed(REPLACEMENTS)] if args.undo else REPLACEMENTS
    for before, after in pairs:
        if updated.count(before.encode()) != 1:
            parser.error("A UI patch anchor was missing or ambiguous.")
        updated = updated.replace(before.encode(), after.encode())
    if sha256(updated).hexdigest() != target:
        parser.error("The patched bundle did not match the expected checksum.")

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
    print("Restart Pi to load the updated UI.")


if __name__ == "__main__":
    main()
