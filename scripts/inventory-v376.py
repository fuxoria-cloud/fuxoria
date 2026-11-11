"""盘点3.7.6的控制器、表结构与插件，不执行PHP，不读取配置值或安装数据。
调用：python3 scripts/inventory-v376.py；参数可指定原项目目录与输出JSON。
公共方法声明只作源码证据，不把它们全部当成已经开放的HTTP路由。
"""
from pathlib import Path
import hashlib
import json
import re
import sys

source = Path(sys.argv[1] if len(sys.argv) > 1 else '~/zjmfv376').expanduser().resolve()
# 对外清单用~表示当前主目录，保留原文件摘要而不写入本机用户名。
home = Path.home().resolve()
source_label = ('~/' + source.relative_to(home).as_posix()) if source.is_relative_to(home) else str(source)
output = Path(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / 'reference/zjmfv376-inventory.json')
version = (source / 'version').read_text().strip()
controllers = []
for area in ('home', 'admin', 'api'):
    for file in sorted((source / 'app' / area / 'controller').glob('*.php')):
        text = file.read_text(errors='replace')
        methods = []
        for match in re.finditer(r'\bpublic\s+(?:static\s+)?function\s+(\w+)\s*\(', text):
            name = match.group(1)
            if not name.startswith('_') and name not in ('initialize', 'construct'):
                methods.append({'name': name, 'line': text.count('\n', 0, match.start()) + 1})
        controllers.append({'area': area, 'file': str(file.relative_to(source)), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'methods': methods})

sql = source / 'public/install/thinkcmf.sql'
text = sql.read_text(errors='replace')
tables = []
for match in re.finditer(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`\s*\((.*?)\)\s*(?:ENGINE|;)', text, re.S | re.I):
    tables.append({'name': match.group(1), 'file': str(sql.relative_to(source)), 'line': text.count('\n', 0, match.start()) + 1, 'columns': re.findall(r'^\s*`([^`]+)`\s+', match.group(2), re.M)})
plugins = []
for category in sorted((source / 'public/plugins').iterdir()):
    if category.is_dir():
        plugins.extend({'category': category.name, 'name': item.name, 'path': str(item.relative_to(source))} for item in sorted(category.iterdir()) if item.is_dir() and not item.name.startswith('.'))

result = {'version': version, 'source': source_label, 'summary': {'controllers': len(controllers), 'publicMethodDeclarations': sum(len(item['methods']) for item in controllers), 'tableDeclarations': len(tables), 'uniqueTables': len({item['name'] for item in tables}), 'plugins': len(plugins)}, 'controllers': controllers, 'tables': tables, 'plugins': plugins}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'version': version, **result['summary']}, ensure_ascii=False))
