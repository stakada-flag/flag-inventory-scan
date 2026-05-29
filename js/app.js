/**
 * 在庫検品アプリ — フロントエンド SPA
 *
 * GitHub Pages から配信される静的アセット。
 * GAS WebApp の /exec エンドポイントに fetch (CORS-safe, text/plain) で JSON-POST する。
 *
 * - API URL とスプシ URL は初回画面でユーザーが入力し localStorage に保存。
 * - カメラ読取は html5-qrcode（vendor 配下）。
 *   主機能 = リアルタイムカメラ。フォールバック = <input type="file" capture> + BarcodeDetector / Html5Qrcode.scanFile。
 */

(function () {
  'use strict';

  // ===== ストレージキー =====
  var LS_API_URL = 'inv.apiUrl';
  var LS_URL = 'inv.sheetUrl';
  var LS_SESSION = 'inv.session';
  var LS_PENDING = 'inv.pendingScans';
  var LS_LAST_CAMERA = 'inv.lastCameraId';

  // ===== デフォルト URL（初回起動時の値・localStorage に保存されたら上書きされる） =====
  var DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbw1nlN7LkIR-kON1lfGVUMtdTRzlqyi0DkQxavUPBQXirmEaJPXe35hfRgTIPtwRGFY/exec';
  var DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1p7MsGw5Tuji3dmkWOKRJm0Zin8TRDdsvWZjh7GRh8CI/edit?gid=1606158276#gid=1606158276';

  // ===== 状態 =====
  var state = {
    apiUrl: localStorage.getItem(LS_API_URL) || DEFAULT_API_URL,
    sheetUrl: localStorage.getItem(LS_URL) || DEFAULT_SHEET_URL,
    storeNames: [],
    session: null,           // { storeName, inspector, location, sessionId, startedAt }
    pending: [],             // [{ ts, jan, qty, note, productName }]
    cameras: [],
    cameraIndex: 0,
    qr: null,                // Html5Qrcode instance
    cameraRunning: false,
    lastDetectedAt: 0,
    lastDetectedValue: ''
  };

  // ===== DOM ヘルパ =====
  function $(id) { return document.getElementById(id); }
  function showView(name) {
    ['setup', 'session', 'scan', 'summary'].forEach(function (v) {
      var el = $('view-' + v);
      if (el) el.classList.toggle('active', v === name);
    });
  }
  function toast(msg, kind) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 3000);
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function genSessionId() {
    var d = new Date();
    var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes());
    var rnd = Math.floor(Math.random() * 10000);
    return 'INV-' + stamp + '-' + (pad(rnd).length === 2 ? '00' + pad(rnd) : ('' + rnd).padStart(4, '0'));
  }

  // ===== GAS API 呼出（CORS-safe text/plain POST） =====
  // GAS WebApp の /exec は ContentService 経由のレスポンスに自動で
  // Access-Control-Allow-Origin: * を付与するが、preflight (OPTIONS) は受けない。
  // → Content-Type を text/plain にすることで simple request 扱いとし preflight を回避する。
  function apiCall(action, args) {
    if (!state.apiUrl) {
      return Promise.reject(new Error('API URL 未設定'));
    }
    return fetch(state.apiUrl, {
      method: 'POST',
      mode: 'cors',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, args: args || [] })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // ===== 起動 =====
  function init() {
    bindEvents();
    loadPending();
    refreshPendingUI();

    $('api-url').value = state.apiUrl || '';
    $('sheet-url').value = state.sheetUrl || '';

    // 既にセッションがあれば検品画面へ
    var savedSess = readSession();
    if (state.apiUrl && state.sheetUrl && savedSess) {
      state.session = savedSess;
      enterScanView();
    } else if (state.apiUrl && state.sheetUrl) {
      goSessionView();
    } else {
      showView('setup');
    }

    // 店舗一覧と version 取得（API URL があるときのみ）
    if (state.apiUrl) {
      apiCall('getConfig').then(function (cfg) {
        if (cfg && cfg.ok) {
          state.storeNames = cfg.storeNames || [];
          $('app-version').textContent = cfg.appVersion || '';
          fillStoreSelect();
        }
      }).catch(function () {});
    }
  }

  function fillStoreSelect() {
    var sel = $('sess-store');
    if (!sel) return;
    sel.innerHTML = '';
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '— 店舗を選択 —';
    sel.appendChild(opt0);
    state.storeNames.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    });
    var custom = document.createElement('option');
    custom.value = '__other__';
    custom.textContent = 'その他（手入力）';
    sel.appendChild(custom);
  }

  // ===== イベント =====
  function bindEvents() {
    $('btn-test-url').addEventListener('click', onTestUrl);
    $('btn-save-url').addEventListener('click', onSaveUrl);

    $('btn-start-session').addEventListener('click', onStartSession);
    $('btn-back-to-setup').addEventListener('click', function () {
      stopCamera();
      showView('setup');
    });
    $('sess-store').addEventListener('change', function (e) {
      if (e.target.value === '__other__') {
        var v = prompt('店舗名を入力してください');
        if (v) {
          var opt = document.createElement('option');
          opt.value = v; opt.textContent = v; opt.selected = true;
          e.target.appendChild(opt);
          state.storeNames.push(v);
        } else {
          e.target.value = '';
        }
      }
    });

    $('btn-end-session').addEventListener('click', onEndSession);
    $('btn-camera-toggle').addEventListener('click', onToggleCamera);
    $('btn-camera-switch').addEventListener('click', onSwitchCamera);

    if ($('btn-fallback-camera')) {
      $('btn-fallback-camera').addEventListener('click', function () {
        $('fallback-file-input').click();
      });
      $('fallback-file-input').addEventListener('change', onFallbackFileChange);
    }

    $('input-jan').addEventListener('input', onJanInput);
    $('btn-qty-minus').addEventListener('click', function () { adjustQty(-1); });
    $('btn-qty-plus').addEventListener('click', function () { adjustQty(1); });
    $('btn-add-scan').addEventListener('click', onAddScan);
    $('btn-flush').addEventListener('click', onFlush);

    $('btn-new-session').addEventListener('click', function () {
      clearSession();
      goSessionView();
    });
    $('btn-close').addEventListener('click', function () { window.close(); });

    window.addEventListener('online', onOnline);
  }

  // ===== View A: URL 設定 =====
  function onTestUrl() {
    var apiUrl = ($('api-url').value || '').trim();
    var sheetUrl = ($('sheet-url').value || '').trim();
    if (!apiUrl) { toast('GAS API URL を入力してください', 'error'); return; }
    if (!sheetUrl) { toast('スプレッドシート URL を入力してください', 'error'); return; }
    // 暫定で apiUrl を state に入れて apiCall を回す
    state.apiUrl = apiUrl;
    $('setup-result').textContent = '接続テスト中...';
    $('btn-save-url').disabled = true;
    apiCall('validateSheetUrl', [sheetUrl]).then(function (res) {
      if (!res || !res.ok) {
        $('setup-result').innerHTML = '<span style="color:#C0504D">' + escapeHtml(res && res.message || 'エラー') + '</span>';
        return;
      }
      var lines = [];
      lines.push('✓ シート「' + escapeHtml(res.ssName) + '」に接続できました');
      lines.push('✓ 検品ログシート「scans」: ' + (res.scansReady ? '準備完了' : '作成失敗'));
      if (res.hasProductMaster && res.productMasterInfo) {
        lines.push('✓ 商品マスタ「' + escapeHtml(res.productMasterInfo.sheetName) + '」検出（' + res.productMasterInfo.rows + '件）');
      } else {
        lines.push('▲ 商品マスタは未検出（検品は可能。JAN→商品名は表示されません）');
      }
      $('setup-result').innerHTML = lines.join('<br>');
      $('btn-save-url').disabled = false;
    }).catch(function (e) {
      $('setup-result').innerHTML = '<span style="color:#C0504D">通信エラー: ' + escapeHtml(e && e.message || '') + '</span>';
    });
  }

  function onSaveUrl() {
    var apiUrl = ($('api-url').value || '').trim();
    var sheetUrl = ($('sheet-url').value || '').trim();
    if (!apiUrl || !sheetUrl) return;
    state.apiUrl = apiUrl;
    state.sheetUrl = sheetUrl;
    localStorage.setItem(LS_API_URL, apiUrl);
    localStorage.setItem(LS_URL, sheetUrl);
    // 店舗一覧再取得
    apiCall('getConfig').then(function (cfg) {
      if (cfg && cfg.ok) {
        state.storeNames = cfg.storeNames || [];
        $('app-version').textContent = cfg.appVersion || '';
        fillStoreSelect();
      }
    }).catch(function () {});
    goSessionView();
  }

  // ===== View B: セッション開始 =====
  function goSessionView() {
    showView('session');
    var last = readLastInputs();
    if (last.inspector) $('sess-inspector').value = last.inspector;
    if (last.location) $('sess-location').value = last.location;
  }
  function readLastInputs() {
    try {
      return JSON.parse(localStorage.getItem('inv.lastInputs') || '{}');
    } catch (e) { return {}; }
  }
  function saveLastInputs(inspector, location) {
    localStorage.setItem('inv.lastInputs', JSON.stringify({ inspector: inspector, location: location }));
  }
  function onStartSession() {
    var store = $('sess-store').value;
    var inspector = ($('sess-inspector').value || '').trim();
    var location = ($('sess-location').value || '').trim();
    if (!store || store === '__other__') { toast('店舗を選択してください', 'error'); return; }
    if (!inspector) { toast('検品者名を入力してください', 'error'); return; }

    state.session = {
      storeName: store,
      inspector: inspector,
      location: location,
      sessionId: genSessionId(),
      startedAt: new Date().toISOString()
    };
    localStorage.setItem(LS_SESSION, JSON.stringify(state.session));
    saveLastInputs(inspector, location);
    enterScanView();
  }

  // ===== View C: 検品中 =====
  function enterScanView() {
    showView('scan');
    var s = state.session;
    $('bar-store').textContent = s.storeName;
    $('bar-inspector').textContent = s.inspector;
    if (s.location) {
      $('bar-location').textContent = s.location;
      $('bar-location').hidden = false;
    } else {
      $('bar-location').hidden = true;
    }
    refreshPendingUI();
    startCamera();
  }

  function buildScanConfig() {
    return {
      fps: 10,
      qrbox: function (vw, vh) {
        var minEdge = Math.min(vw, vh);
        var size = Math.floor(minEdge * 0.7);
        return { width: size, height: Math.floor(size * 0.5) };
      },
      aspectRatio: 4 / 3,
      // スマホ背面カメラの高解像度を要求（バーコード認識精度向上）
      videoConstraints: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.QR_CODE
      ]
    };
  }

  function startCamera() {
    if (typeof Html5Qrcode === 'undefined') {
      $('cam-status').textContent = 'カメラライブラリの読込に失敗しました（再読込してください）。';
      return;
    }
    if (!state.qr) {
      state.qr = new Html5Qrcode('qr-reader', { verbose: false });
    }
    // 起動順序:
    //   1. facingMode: 'environment' で背面カメラを直接指定（iOS Safari 対策）
    //   2. 失敗したら cameraId 方式で fallback
    var config = buildScanConfig();
    state.qr.start({ facingMode: { ideal: 'environment' } }, config, onDetected, function () {})
      .then(function () {
        state.cameraRunning = true;
        $('cam-status').textContent = 'カメラ起動中（背面）';
        // カメラ切替ボタン用に一覧を取得（権限承認後は labels も取れる）
        Html5Qrcode.getCameras().then(function (devices) {
          state.cameras = devices || [];
        }).catch(function () {});
      })
      .catch(function () {
        // facingMode で失敗 → cameraId 方式へ fallback
        Html5Qrcode.getCameras().then(function (devices) {
          state.cameras = devices || [];
          if (!state.cameras.length) {
            enableFallbackCamera('カメラが見つかりません。');
            return;
          }
          var lastId = localStorage.getItem(LS_LAST_CAMERA);
          state.cameraIndex = 0;
          if (lastId) {
            var idx = state.cameras.findIndex(function (c) { return c.id === lastId; });
            if (idx >= 0) state.cameraIndex = idx;
          } else {
            var backIdx = state.cameras.findIndex(function (c) { return /back|rear|environment/i.test(c.label || ''); });
            if (backIdx >= 0) state.cameraIndex = backIdx;
          }
          doStartByCameraId();
        }).catch(function (e) {
          enableFallbackCamera('カメラ起動エラー: ' + (e && e.message || e));
        });
      });
  }

  function doStartByCameraId() {
    if (!state.cameras.length) return;
    var cam = state.cameras[state.cameraIndex];
    var config = buildScanConfig();
    state.qr.start(cam.id, config, onDetected, function () {})
      .then(function () {
        state.cameraRunning = true;
        $('cam-status').textContent = 'カメラ起動中（' + (cam.label || cam.id) + '）';
        localStorage.setItem(LS_LAST_CAMERA, cam.id);
      })
      .catch(function (e) {
        enableFallbackCamera('カメラへのアクセスが拒否されました: ' + (e && e.message || e));
      });
  }

  function enableFallbackCamera(reason) {
    $('cam-status').textContent = reason + ' 📸撮影ボタンをご利用ください。';
    if ($('camera-controls')) $('camera-controls').hidden = true;
    if ($('fallback-controls')) $('fallback-controls').hidden = false;
  }

  function onFallbackFileChange(e) {
    if (!e.target.files || e.target.files.length === 0) return;
    var file = e.target.files[0];
    $('cam-status').textContent = '画像読み込み中...';

    var reader = new FileReader();
    reader.onload = function (event) {
      var img = new Image();
      img.onload = function () {
        // 1. ネイティブの BarcodeDetector API が使える環境（最新Android/iOS等）なら最優先で使用（超高精度・爆速）
        if ('BarcodeDetector' in window) {
          try {
            var detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'qr_code', 'code_128', 'upc_a', 'upc_e'] });
            detector.detect(img).then(function (barcodes) {
              if (barcodes.length > 0) {
                onScanSuccess(barcodes[0].rawValue, e.target);
              } else {
                fallbackToHtml5Qrcode(img, file, e.target);
              }
            }).catch(function () {
              fallbackToHtml5Qrcode(img, file, e.target);
            });
            return;
          } catch (err) {
            fallbackToHtml5Qrcode(img, file, e.target);
            return;
          }
        }
        // ネイティブAPIがない場合はフォールバック
        fallbackToHtml5Qrcode(img, file, e.target);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }

  function fallbackToHtml5Qrcode(img, originalFile, inputEl) {
    $('cam-status').textContent = '画質最適化中...';
    // バーコード解析エンジン(ZXing等)は静止画の1Dバーコードに非常に弱いため、
    // 白黒のコントラストを極限まで強調（二値化）してからエンジンに渡す
    var MAX_SIZE = 1000;
    var w = img.width, h = img.height;
    if (w > h && w > MAX_SIZE) { h = Math.floor(h * (MAX_SIZE / w)); w = MAX_SIZE; }
    else if (h > w && h > MAX_SIZE) { w = Math.floor(w * (MAX_SIZE / h)); h = MAX_SIZE; }
    else if (w === h && w > MAX_SIZE) { w = MAX_SIZE; h = MAX_SIZE; }

    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    var imgData = ctx.getImageData(0, 0, w, h);
    var data = imgData.data;
    for (var i = 0; i < data.length; i += 4) {
      var brightness = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      var val = brightness < 128 ? Math.max(0, brightness - 60) : Math.min(255, brightness + 60);
      data[i] = val; data[i + 1] = val; data[i + 2] = val;
    }
    ctx.putImageData(imgData, 0, 0);

    canvas.toBlob(function (blob) {
      var optimizedFile = new File([blob], originalFile.name, { type: 'image/jpeg' });
      doScanFile(optimizedFile, inputEl);
    }, 'image/jpeg', 0.9);
  }

  function doScanFile(file, inputEl) {
    $('cam-status').textContent = '解析エンジン実行中...';
    if (!state.qr) {
      state.qr = new Html5Qrcode('qr-reader', { verbose: false });
    }
    state.qr.scanFile(file, true)
      .then(function (decodedText) {
        onScanSuccess(decodedText, inputEl);
      })
      .catch(function () {
        toast('バーコードが検出できませんでした', 'error');
        $('cam-status').textContent = '検出失敗。少し離すか、明るい場所で撮り直してください。';
        if (inputEl) inputEl.value = '';
      });
  }

  function onScanSuccess(decodedText, inputEl) {
    $('cam-status').textContent = '解析完了。次の読取をお待ちしています';
    onDetected(decodedText);
    if (inputEl) inputEl.value = '';
  }

  function onDetected(decodedText) {
    var now = Date.now();
    // 同一値 800ms 以内はスキップ（重複検出ガード）
    if (decodedText === state.lastDetectedValue && (now - state.lastDetectedAt) < 800) return;
    state.lastDetectedValue = decodedText;
    state.lastDetectedAt = now;
    $('input-jan').value = decodedText;
    onJanInput();
    if (navigator.vibrate) { try { navigator.vibrate(50); } catch (e) {} }
  }

  function stopCamera(cb) {
    if (state.qr && state.cameraRunning) {
      state.qr.stop().then(function () {
        state.cameraRunning = false;
        if (cb) cb();
      }).catch(function () { state.cameraRunning = false; if (cb) cb(); });
    } else if (cb) {
      cb();
    }
  }

  function onToggleCamera() {
    if (state.cameraRunning) {
      stopCamera(function () {
        $('cam-status').textContent = 'カメラ停止中';
        $('btn-camera-toggle').textContent = '再開';
      });
    } else {
      $('btn-camera-toggle').textContent = '一時停止';
      startCamera();
    }
  }

  function onSwitchCamera() {
    function doSwitch() {
      if (!state.cameras.length || state.cameras.length < 2) {
        toast('切替可能なカメラがありません', 'error');
        return;
      }
      stopCamera(function () {
        state.cameraIndex = (state.cameraIndex + 1) % state.cameras.length;
        doStartByCameraId();
      });
    }
    if (!state.cameras.length) {
      // facingMode 起動だったため未取得 → 取得してから切替
      Html5Qrcode.getCameras().then(function (devices) {
        state.cameras = devices || [];
        doSwitch();
      }).catch(function () {
        toast('カメラ一覧が取得できません', 'error');
      });
      return;
    }
    doSwitch();
  }

  // JAN 入力時に商品マスタ照会
  var lookupTimer = null;
  function onJanInput() {
    var jan = ($('input-jan').value || '').trim();
    $('product-name').textContent = '';
    if (!jan) return;
    if (lookupTimer) clearTimeout(lookupTimer);
    lookupTimer = setTimeout(function () {
      apiCall('lookupProduct', [state.sheetUrl, jan]).then(function (res) {
        if (res && res.ok) {
          $('product-name').textContent = res.name ? res.name : '（未登録）';
        }
      }).catch(function () {});
    }, 250);
  }

  function adjustQty(delta) {
    var el = $('input-qty');
    var v = parseInt(el.value, 10);
    if (!isFinite(v)) v = 0;
    v = Math.max(0, v + delta);
    el.value = v;
  }

  function onAddScan() {
    var jan = ($('input-jan').value || '').trim();
    var qty = parseInt($('input-qty').value, 10);
    var note = ($('input-note').value || '').trim();
    if (!jan) { toast('バーコード値が空です', 'error'); return; }
    if (!isFinite(qty) || qty < 0) { toast('数量が不正です', 'error'); return; }
    var productName = $('product-name').textContent || '';
    if (productName === '（未登録）') productName = '';

    var scan = {
      ts: new Date().toISOString(),
      jan: jan,
      qty: qty,
      note: note,
      productName: productName
    };
    state.pending.push(scan);
    savePending();
    refreshPendingUI();

    $('input-jan').value = '';
    $('input-qty').value = 1;
    $('input-note').value = '';
    $('product-name').textContent = '';
    state.lastDetectedValue = '';
    toast('追加しました', 'success');
  }

  function onFlush() {
    if (!state.pending.length) { toast('送信対象がありません', 'error'); return; }
    if (!navigator.onLine) { toast('オフラインです。回線復帰後に再送信してください', 'error'); return; }
    var btn = $('btn-flush');
    btn.disabled = true;
    btn.textContent = '送信中...';
    apiCall('appendScans', [state.sheetUrl, state.session, state.pending])
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'シートに送信';
        if (res && res.ok) {
          toast(res.written + ' 件送信しました', 'success');
          state.pending = [];
          savePending();
          refreshPendingUI();
        } else {
          toast((res && res.message) || '送信失敗', 'error');
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        btn.textContent = 'シートに送信';
        toast('通信エラー（未送信は保持されます）', 'error');
      });
  }

  function onOnline() {
    if (state.pending.length) {
      toast('オンライン復帰。「シートに送信」を押すと未送信分を送れます', 'success');
    }
  }

  // ===== View D: 集計 =====
  function onEndSession() {
    if (state.pending.length) {
      if (!confirm('未送信のスキャンが ' + state.pending.length + ' 件あります。先に送信しなくてよろしいですか？')) return;
    }
    stopCamera();
    var s = state.session;
    apiCall('getSessionSummary', [state.sheetUrl, s && s.sessionId])
      .then(function (res) {
        showView('summary');
        if (res && res.ok) {
          $('sum-count').textContent = res.count;
          $('sum-unique').textContent = res.uniqueJans;
          $('sum-total-qty').textContent = res.totalQty;
        }
        if (s && s.startedAt) {
          var ms = Date.now() - new Date(s.startedAt).getTime();
          var mins = Math.max(1, Math.round(ms / 60000));
          $('sum-elapsed').textContent = mins + '分';
        }
      })
      .catch(function () { showView('summary'); });
  }

  // ===== ストレージ =====
  function readSession() {
    try { return JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch (e) { return null; }
  }
  function clearSession() {
    localStorage.removeItem(LS_SESSION);
    state.session = null;
  }
  function loadPending() {
    try { state.pending = JSON.parse(localStorage.getItem(LS_PENDING) || '[]') || []; } catch (e) { state.pending = []; }
  }
  function savePending() {
    localStorage.setItem(LS_PENDING, JSON.stringify(state.pending));
  }
  function refreshPendingUI() {
    var ul = $('pending-list');
    if (!ul) return;
    ul.innerHTML = '';
    var recent = state.pending.slice(-10).reverse();
    recent.forEach(function (s) {
      var li = document.createElement('li');
      var left = document.createElement('div');
      var jan = document.createElement('div');
      jan.style.fontFamily = '"SF Mono","Menlo","Consolas",monospace';
      jan.textContent = s.jan;
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = (s.productName || '') + (s.note ? ' / ' + s.note : '');
      left.appendChild(jan);
      left.appendChild(meta);
      var right = document.createElement('strong');
      right.textContent = '×' + s.qty;
      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    });
    $('pending-badge').textContent = '未送信 ' + state.pending.length + ' 件';
    $('pending-badge').className = 'badge' + (state.pending.length ? ' alert' : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
