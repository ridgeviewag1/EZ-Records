import 'package:flutter/material.dart';
import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

void main() { WidgetsFlutterBinding.ensureInitialized(); runApp(const EZRecords()); }
class EZRecords extends StatelessWidget {
  const EZRecords({super.key});
  @override Widget build(BuildContext context) => MaterialApp(title: 'EZ Records', theme: ThemeData(colorSchemeSeed: Colors.green, useMaterial3: true), home: const RecordsPage());
}
class RecordsPage extends StatefulWidget {
  const RecordsPage({super.key});
  @override State<RecordsPage> createState() => _RecordsPageState();
}
class _RecordsPageState extends State<RecordsPage> {
  Database? db;
  List<Map<String, Object?>> records = [];
  @override void initState() { super.initState(); init(); }
  Future<void> init() async {
    final database = await openDatabase(join(await getDatabasesPath(), 'ez_records.db'), version: 1, onCreate: (db, v) async {
      await db.execute('CREATE TABLE applications (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, farm TEXT NOT NULL, field TEXT NOT NULL, crop TEXT NOT NULL, acres REAL NOT NULL, product TEXT NOT NULL, rate REAL NOT NULL, unit TEXT NOT NULL, applicator TEXT NOT NULL, wind TEXT NOT NULL, notes TEXT NOT NULL)');
    });
    db = database;
    await refresh();
  }
  Future<void> refresh() async {
    final result = await db!.query('applications', orderBy: 'id DESC');
    if (mounted) setState(() => records = result);
  }
  Future<void> add() async {
    final keys = ['farm', 'field', 'crop', 'acres', 'product', 'rate', 'unit', 'applicator', 'wind', 'notes'];
    final labels = ['Farm', 'Field', 'Crop', 'Acres', 'Herbicide product', 'Rate per acre', 'Rate unit (e.g. fl oz/acre)', 'Applicator', 'Wind speed and direction', 'Notes'];
    final controllers = [for (final _ in keys) TextEditingController()];
    final form = GlobalKey<FormState>();
    try {
      final save = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
        title: const Text('New application'),
        content: SizedBox(width: 450, child: Form(key: form, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 0; i < keys.length; i++) Padding(padding: const EdgeInsets.only(bottom: 10), child: TextFormField(controller: controllers[i], decoration: InputDecoration(labelText: labels[i]), keyboardType: (keys[i] == 'acres' || keys[i] == 'rate') ? const TextInputType.numberWithOptions(decimal: true) : TextInputType.text, validator: (v) {
            if (keys[i] == 'notes' || keys[i] == 'wind') return null;
            if (v == null || v.trim().isEmpty) return 'Required';
            if ((keys[i] == 'acres' || keys[i] == 'rate') && (double.tryParse(v) == null || double.parse(v) <= 0)) return 'Enter a positive number';
            return null;
          }))
        ])))),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')), FilledButton(onPressed: () { if (form.currentState!.validate()) Navigator.pop(ctx, true); }, child: const Text('Save offline'))],
      ));
      if (save == true && db != null) {
        final data = <String, Object?>{'date': DateTime.now().toIso8601String()};
        for (var i = 0; i < keys.length; i++) { data[keys[i]] = (keys[i] == 'acres' || keys[i] == 'rate') ? double.parse(controllers[i].text) : controllers[i].text.trim(); }
        await db!.insert('applications', data);
        await refresh();
      }
    } finally { for (final c in controllers) { c.dispose(); } }
  }
  @override Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('EZ Records')), floatingActionButton: FloatingActionButton.extended(onPressed: db == null ? null : add, icon: const Icon(Icons.add), label: const Text('New record')), body: db == null ? const Center(child: CircularProgressIndicator()) : records.isEmpty ? const Center(child: Text('No spray records yet. Tap New record to begin.')) : ListView.builder(itemCount: records.length, itemBuilder: (ctx, i) { final r = records[i]; return Card(child: ListTile(title: Text('${r['farm']} — ${r['field']}'), subtitle: Text('${r['product']} • ${r['acres']} acres • ${r['date'].toString().substring(0, 10)}'), onTap: () => showDialog<void>(context: context, builder: (ctx) => AlertDialog(title: const Text('Application record'), content: SingleChildScrollView(child: Text(r.entries.where((e) => e.key != 'id').map((e) => '${e.key}: ${e.value}').join('\n'))), actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Close'))])))); }));
}
