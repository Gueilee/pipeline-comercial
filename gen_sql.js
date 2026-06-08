const XLSX = require('./node_modules/xlsx');
const fs   = require('fs');

// segmento por CLIENTE-GRAFICO (preservado do banco + novos clientes)
const SEG = {
  '100 FRESCURA':           'Alimentos',
  'AC COMERCIAL(AMAZON)':   'Marketplace / E-commerce',
  'ACQUA':                  'Tratamento de água / saneamento',
  'ACRILSUL':               'Acrílicos / Comunicação Visual',
  'ALPLA GROUP':            'Embalagens plásticas industriais',
  'ARTECOLA':               'Adesivos e químicos industriais',
  'ASSA ABLOY':             'Fechaduras, controle de acesso e segurança',
  'ASSA ABLOY (UDINESE)':   'Segurança e fechaduras',
  'AUTONICS':               'Automação industrial',
  'COGRA DISTRIBUIDORA':    'Distribuição de tecnologia e impressão',
  'COMASK':                 'Embalagens / plásticos industriais',
  'COMBE':                  'Higiene pessoal e farmacêutico',
  'CORE CARGO':             'Logística internacional',
  'CORR PLASTIK':           'Tubos, conexões e plásticos para construção/saneamento',
  'DTJX (Klava Brands)':    'Cosméticos',
  'DURST':                  'Impressão digital industrial',
  'EMOB SOLUCOES':          'Mobilidade elétrica',
  'ENGIE':                  'Energia elétrica e infraestrutura',
  'ERCA':                   'Máquinas para embalagens',
  'FARO':                   'Metrologia e escaneamento 3D',
  'HILTI':                  'Construção civil e ferramentas',
  'ITAPOA TERMINAIS':       'Operação portuária',
  'KLAVA':                  'Cosméticos / marcas próprias',
  'LEAR':                   'Autopeças',
  'NEC LATIN':              'Tecnologia e telecomunicações',
  'NOVOS CLIENTES':         null,
  'ONZZI':                  'Cosméticos e beleza',
  'ONZZIALU':               'Cosméticos e beleza',
  'OTOBAI':                 'Motocicletas',
  'RAIZEN ENERGIA':         'Energia elétrica e infraestrutura',
  'SEARS SEATING':          'Bancos e assentos industriais',
  'TRICON':                 'Logística e comércio exterior',
  'TRP - CTE PRÓPRIO':      'Transporte rodoviário',
  'TRP - FRETE TERCEIRO':   'Transporte rodoviário',
  'UFI FILTERS':            'Filtros automotivos e industriais',
  'VIPAL':                  'Borracha e recapagem de pneus',
  'WEIDMULLER':             'Automação e conectividade elétrica',
  'ZARAPLAST':              'Embalagens plásticas flexíveis',
  'MTB SUDOESTE':           'Transporte rodoviário',
  'BRASIL SUL':             'Logística e transporte',
  'LOTALU':                 null,
};

const wb   = XLSX.readFile('hoje.xlsx');
const ws   = wb.Sheets['Planilha1'];
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
const rows = data.slice(2); // pula linhas 0 (mês) e 1 (cabeçalho)

function esc(v) {
    if (v === null || v === undefined) return 'NULL';
    return "'" + String(v).replace(/'/g, "''") + "'";
}
function num(v) {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

// status por mês: 1-5 faturado, 6+ pedidos em carteira
function statusMes(m) {
    return m <= 5 ? 'FATURADO' : 'PEDIDOS EM CASA';
}

const vals = [];

rows.forEach(row => {
    if (!row[0] && !row[1] && !row[2]) return;

    const grafico   = (row[2] || '').trim();
    const categoria = (row[3] || '').trim();
    const quatroPl  = (row[4] || '').trim();
    const vendedor  = (row[5] || '').trim();
    const bu        = (row[6] || '').trim();

    // pula linha duplicada DTJX(KLAVA) ARM-NVG
    if (grafico === 'DTJX(KLAVA)') return;

    const segSQL = SEG.hasOwnProperty(grafico) && SEG[grafico] ? esc(SEG[grafico]) : 'NULL';

    for (let m = 1; m <= 12; m++) {
        const pCol = 5 + m * 2; // PLANO: 7,9,...,29
        const fCol = 6 + m * 2; // FATURADO/PEDIDO: 8,10,...,30

        const rawP = row[pCol];
        const rawF = row[fCol];

        if (rawP === undefined && rawF === undefined) continue;
        if (rawP === null     && rawF === null)       continue;

        const p = num(rawP);
        const f = num(rawF);
        if (p === 0 && f === 0) continue; // não insere linhas zeradas

        vals.push(
            `(${m},${esc(grafico)},${esc(bu)},${esc(categoria)},2026,${p},${f},${esc(categoria)},${esc(statusMes(m))},${esc(vendedor)},${esc(quatroPl)},${segSQL})`
        );
    }
});

const sql = `-- Substitui todos os dados de 2026 pelos do arquivo hoje.xlsx
BEGIN;

DELETE FROM resultados_mensais WHERE ano = 2026;

INSERT INTO resultados_mensais
  (mes_numero, cliente, bu, categoria, ano, valor_planejado, valor_realizado, tipo, status, vendedor, quatro_pl, segmento)
VALUES
${vals.join(',\n')};

COMMIT;
`;

fs.writeFileSync('update_dados.sql', sql);
console.log('SQL gerado: ' + vals.length + ' linhas de insert');
