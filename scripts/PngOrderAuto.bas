Attribute VB_Name = "PngOrderAuto"
Option Explicit

' ============================================================
' PngOrderAuto.bas
' Macro for CorelDRAW (Modern Armor PNG_order_bot).
' Flow:
'   1. ShowPngOrderForm > UserForm: Order ID field + 2 buttons.
'   2. Form calls one of:
'        RunForOrder(orderId)  — fetch + render one order
'        RunForToday()         — batch: today's orders (shipping_date)
'        RunForAll()           — batch: all active Modern Armor orders
'   3. Each entry invokes Node helper png_order_fetch.js with arg
'      (orderId | "today" | "all"). The helper writes file_list.txt
'      and prints_list.txt with new format (order_id is first column).
'   4. RunNodeAndRender groups rows by order_id and renders every order
'      one under another on a single tall page; logo template imported once.
'
' file_list.txt columns:
'   order_id|index|type|logo|callsign_flag|under_logo|callsigns|quantity
' prints_list.txt columns:
'   order_id|abs_path|count
' viz_list.txt columns (one row per viz file; imported left-of prints):
'   order_id|abs_path|index
' ============================================================

' === Paths (ASCII only - no Cyrillic in literals) ===
Private Const LOGO_PATH As String = "C:\PNG_ORDER\lib\modern_logo.cdr"
Private Const FILE_LIST_PATH As String = "C:\PNG_ORDER\file_list.txt"
Private Const PRINTS_LIST_PATH As String = "C:\PNG_ORDER\prints_list.txt"
Private Const VIZ_LIST_PATH As String = "C:\PNG_ORDER\viz_list.txt"
Private Const ERRORS_LOG_PATH As String = "C:\PNG_ORDER\errors.log"
Private Const LOG_PATH As String = "C:\PNG_ORDER\logs\vba.log"
Private Const NODE_EXE As String = "C:\Program Files\nodejs\node.exe"
Private Const FETCH_SCRIPT As String = "C:\PNG_ORDER\scripts\png_order_fetch.js"

' === Layout (millimeters) ===
Private Const CALLSIGN_FONT As String = "Core Sans A 85 Heavy"
Private Const CALLSIGN_WIDTH_MM As Double = 60
Private Const CALLSIGN_HEIGHT_MM As Double = 20
Private Const LOGO_GAP_MM As Double = 5
Private Const ROW_GAP_MM As Double = 30
Private Const COL_GAP_MM As Double = 40
Private Const PAGE_MARGIN_MM As Double = 20
Private Const BLOCK_STEP_MM As Double = 100  ' callsign width 60 + col gap 40
Private Const INTRA_COL_GAP_MM As Double = 10  ' gap between print copies in one column
Private Const INTER_ORDER_GAP_MM As Double = 60  ' vertical gap between orders in batch mode
Private Const PAGE_GROWTH_MM As Double = 2000   ' grow page height when running out

' ============================================================
' ENTRY POINTS
' ============================================================
Public Sub ShowPngOrderForm()
    PngOrderForm.Show
End Sub

Public Sub RunForToday()
    Call RunNodeAndRender("today")
End Sub

Public Sub RunForAll()
    Call RunNodeAndRender("all")
End Sub

Public Sub RunModernArmor()
    Dim id As String
    id = Trim(InputBox("Order number (Modern Armor):", "PNG Order"))
    If Len(id) = 0 Then Exit Sub
    If Not IsNumeric(id) Then
        MsgBox "Order number must be numeric.", vbExclamation
        Exit Sub
    End If
    Call RunForOrder(id)
End Sub

Public Sub RunForOrder(ByVal orderId As String)
    Call RunNodeAndRender(orderId)
End Sub

' Universal worker: invokes Node helper with arg, then renders every order
' from the resulting list files one under another on the active document.
Private Sub RunNodeAndRender(ByVal arg As String)
    On Error GoTo ErrHandler

    Dim tStart As Double, tNode As Double, tBeforeNode As Double
    tStart = Timer
    Call LogToFile(LOG_PATH, "=== START RunNodeAndRender arg=" & arg & " ===" & vbCrLf)

    Dim shell As Object: Set shell = CreateObject("WScript.Shell")
    Dim cmd As String
    cmd = """" & NODE_EXE & """ """ & FETCH_SCRIPT & """ " & arg
    Call LogToFile(LOG_PATH, "shell.Run: " & cmd & vbCrLf)
    tBeforeNode = Timer
    shell.Run cmd, 0, True
    tNode = Timer - tBeforeNode
    Call LogToFile(LOG_PATH, "  Node took " & Format(tNode, "0.00") & " s" & vbCrLf)

    Dim errs As String: errs = ReadFileUtf8(ERRORS_LOG_PATH)
    If Len(Trim(errs)) > 0 Then
        Call LogToFile(LOG_PATH, "Node errors: " & errs & vbCrLf)
        MsgBox errs, vbExclamation, "PNG Order"
        Exit Sub
    End If

    Dim raw As String: raw = ReadFileUtf8(FILE_LIST_PATH)
    If Len(raw) = 0 Then
        MsgBox "file_list.txt is empty - no orders to process.", vbExclamation, "PNG Order"
        Exit Sub
    End If
    raw = Replace(Replace(raw, vbCrLf, vbLf), vbCr, vbLf)
    Dim allLines() As String: allLines = Split(raw, vbLf)
    If UBound(allLines) < 1 Then
        MsgBox "file_list.txt has no data rows.", vbExclamation, "PNG Order"
        Exit Sub
    End If

    Dim pRaw As String: pRaw = ReadFileUtf8(PRINTS_LIST_PATH)
    pRaw = Replace(Replace(pRaw, vbCrLf, vbLf), vbCr, vbLf)
    Dim printLinesAll() As String: printLinesAll = Split(pRaw, vbLf)

    Dim vRaw As String: vRaw = ReadFileUtf8(VIZ_LIST_PATH)
    vRaw = Replace(Replace(vRaw, vbCrLf, vbLf), vbCr, vbLf)
    Dim vizLinesAll() As String: vizLinesAll = Split(vRaw, vbLf)

    ' Group data rows by order_id (preserve first-appearance order).
    Dim orderIds As Collection: Set orderIds = New Collection
    Dim orderLines As Object: Set orderLines = CreateObject("Scripting.Dictionary")
    Dim orderPrints As Object: Set orderPrints = CreateObject("Scripting.Dictionary")
    Dim orderVizes As Object: Set orderVizes = CreateObject("Scripting.Dictionary")

    Dim li As Long
    For li = 1 To UBound(allLines)  ' skip header
        Dim ln As String: ln = Trim(allLines(li))
        If Len(ln) > 0 Then
            Dim toks() As String: toks = Split(ln, "|")
            ' order_id|index|type|logo|callsign_flag|under_logo|callsigns|quantity
            If UBound(toks) >= 6 Then
                Dim oid As String: oid = toks(0)
                If Not orderLines.Exists(oid) Then
                    orderLines.Add oid, New Collection
                    orderPrints.Add oid, New Collection
                    orderVizes.Add oid, New Collection
                    orderIds.Add oid, "k" & oid
                End If
                orderLines(oid).Add ln
            End If
        End If
    Next li

    ' Distribute print rows by order_id.
    Dim pi As Long
    For pi = 0 To UBound(printLinesAll)
        Dim pln As String: pln = Trim(printLinesAll(pi))
        If Len(pln) > 0 Then
            Dim ptoks() As String: ptoks = Split(pln, "|")
            If UBound(ptoks) >= 2 Then
                Dim poid As String: poid = ptoks(0)
                If orderPrints.Exists(poid) Then
                    orderPrints(poid).Add pln
                End If
            End If
        End If
    Next pi

    ' Distribute viz rows by order_id (viz_list.txt: order_id|abs_path|index).
    Dim vi As Long
    For vi = 0 To UBound(vizLinesAll)
        Dim vln As String: vln = Trim(vizLinesAll(vi))
        If Len(vln) > 0 Then
            Dim vtoks() As String: vtoks = Split(vln, "|")
            If UBound(vtoks) >= 1 Then
                Dim void_ As String: void_ = vtoks(0)
                If orderVizes.Exists(void_) Then
                    orderVizes(void_).Add vln
                End If
            End If
        End If
    Next vi

    ' Detect logo-template need + count callsigns.
    Dim needLogo As Boolean: needLogo = False
    Dim totalCallsigns As Long: totalCallsigns = 0
    Dim oi As Long
    For oi = 1 To orderIds.Count
        Dim ocoll As Collection: Set ocoll = orderLines(orderIds(oi))
        Dim ki As Long
        For ki = 1 To ocoll.Count
            Dim cTok() As String: cTok = Split(ocoll(ki), "|")
            If UBound(cTok) >= 6 Then
                If (LCase(cTok(3)) = "true") And (LCase(cTok(5)) = "true") Then needLogo = True
                Dim cs6 As String: cs6 = cTok(6)
                If Len(cs6) > 0 Then
                    Dim cs6Arr() As String: cs6Arr = Split(cs6, ";")
                    Dim cc As Long
                    For cc = LBound(cs6Arr) To UBound(cs6Arr)
                        If Len(Trim(cs6Arr(cc))) > 0 Then totalCallsigns = totalCallsigns + 1
                    Next cc
                End If
            End If
        Next ki
    Next oi
    Call LogToFile(LOG_PATH, "Orders=" & orderIds.Count & " callsigns=" & totalCallsigns & " need_logo=" & needLogo & vbCrLf)

    ' Prepare document, page sized for expected total height.
    Dim doc As Document
    If ActiveDocument Is Nothing Then
        Set doc = CreateDocument
        Call LogToFile(LOG_PATH, "Created new document" & vbCrLf)
    Else
        Set doc = ActiveDocument
    End If
    doc.Unit = cdrMillimeter
    doc.ReferencePoint = cdrBottomLeft

    Dim initialH As Double
    initialH = 1500 + 800 * orderIds.Count
    If initialH < 1000 Then initialH = 1000
    If initialH > 40000 Then initialH = 40000
    On Error Resume Next
    doc.ActivePage.SetSize 1000, initialH
    If Err.Number <> 0 Then
        Err.Clear
        doc.ActivePage.SizeWidth = 1000
        doc.ActivePage.SizeHeight = initialH
    End If
    Err.Clear
    On Error GoTo 0

    If doc.ActiveLayer Is Nothing Then
        Set doc.ActiveLayer = doc.ActivePage.ActiveLayer
    End If

    Dim pageW As Double: pageW = doc.ActivePage.SizeWidth
    Dim pageH As Double: pageH = doc.ActivePage.SizeHeight
    Dim curY As Double: curY = pageH - PAGE_MARGIN_MM

    Dim logoTemplate As Shape: Set logoTemplate = Nothing
    If needLogo Then
        Set logoTemplate = ImportLogo(doc)
        If Not logoTemplate Is Nothing Then logoTemplate.SetPosition -500, -500
    End If

    Dim tRender0 As Double: tRender0 = Timer
    Dim totalPrints As Long: totalPrints = 0
    Dim totalBlocks As Long: totalBlocks = 0

    Dim ordIdx As Long
    For ordIdx = 1 To orderIds.Count
        Dim curOid As String: curOid = orderIds(ordIdx)
        ' Grow page if we approach its bottom.
        If curY - 800 < PAGE_MARGIN_MM Then
            pageH = pageH + PAGE_GROWTH_MM
            On Error Resume Next
            doc.ActivePage.SetSize pageW, pageH
            On Error GoTo 0
        End If
        Dim ret As Variant
        ret = RenderOneOrder(doc, curOid, orderLines(curOid), orderPrints(curOid), orderVizes(curOid), logoTemplate, curY, pageW)
        ' ret = Array(lowestY, printsCount, blocksCount)
        Call LogToFile(LOG_PATH, "  order=" & curOid & " prints=" & ret(1) & " blocks=" & ret(2) & " lowY=" & Format(ret(0), "0") & vbCrLf)
        totalPrints = totalPrints + CLng(ret(1))
        totalBlocks = totalBlocks + CLng(ret(2))
        curY = CDbl(ret(0)) - INTER_ORDER_GAP_MM
    Next ordIdx

    If Not logoTemplate Is Nothing Then
        On Error Resume Next
        logoTemplate.Delete
        On Error GoTo 0
    End If

    Dim tRender As Double: tRender = Timer - tRender0
    Dim tTotal As Double: tTotal = Timer - tStart
    Call LogToFile(LOG_PATH, "=== DONE orders=" & orderIds.Count & " prints=" & totalPrints & _
        " blocks=" & totalBlocks & " | node=" & Format(tNode, "0.00") & "s render=" & _
        Format(tRender, "0.00") & "s total=" & Format(tTotal, "0.00") & "s ===" & vbCrLf)

    MsgBox "Done." & vbCrLf & _
        "Mode: " & arg & vbCrLf & _
        "Orders: " & orderIds.Count & vbCrLf & _
        "Prints: " & totalPrints & vbCrLf & _
        "Callsigns: " & totalBlocks, _
        vbInformation, "PNG Order"
    Exit Sub

ErrHandler:
    Call LogToFile(LOG_PATH, "FATAL: " & Err.Number & " - " & Err.Description & vbCrLf)
    MsgBox "Error: " & Err.Description, vbCritical
End Sub

' Render a single order's prints (column-stacked Row 1) and callsign blocks (Row 2+).
' Returns Variant: Array(lowestY, printsCount, blocksCount).
Private Function RenderOneOrder(doc As Document, oid As String, _
    lines As Collection, prints As Collection, vizes As Collection, _
    logoTemplate As Shape, topY As Double, pageW As Double) As Variant

    Dim currentX As Double: currentX = PAGE_MARGIN_MM
    Dim lowestY As Double: lowestY = topY
    Dim printsCount As Long: printsCount = 0
    Dim blocksCount As Long: blocksCount = 0

    ' Order header text: "#<oid>" at top-left, above the prints row.
    Dim headerH As Double: headerH = 0
    On Error Resume Next
    Dim headerTxt As Shape
    Set headerTxt = doc.ActiveLayer.CreateArtisticText(0, 0, "Order #" & oid)
    If Err.Number = 0 And Not headerTxt Is Nothing Then
        headerTxt.Text.Story.Font = "Arial"
        headerTxt.Text.Story.Size = 48
        headerTxt.Text.Story.Bold = True
        headerTxt.Fill.UniformColor.RGBAssign 0, 0, 0
        headerTxt.Outline.SetNoOutline
        headerTxt.SetPosition PAGE_MARGIN_MM, topY - headerTxt.SizeHeight
        headerH = headerTxt.SizeHeight + 10  ' include small bottom gap
        If (topY - headerH) < lowestY Then lowestY = topY - headerH
    End If
    Err.Clear
    On Error GoTo 0
    Dim rowTopY As Double: rowTopY = topY - headerH

    ' Row 1: VIZ files first (one of each, no duplicates), then prints.
    ' viz_list.txt line is order_id|abs_path|index.
    Dim vk As Long
    For vk = 1 To vizes.Count
        Dim vt() As String: vt = Split(vizes(vk), "|")
        If UBound(vt) >= 1 Then
            Dim vp As String: vp = vt(1)
            Dim vs As Shape: Set vs = Nothing
            Set vs = ImportPrint(doc, vp)
            If Not vs Is Nothing Then
                Dim vw As Double: vw = vs.SizeWidth
                Dim vh As Double: vh = vs.SizeHeight
                Dim vcolY As Double: vcolY = rowTopY - vh
                vs.SetPosition currentX, vcolY
                If vcolY < lowestY Then lowestY = vcolY
                currentX = currentX + vw + COL_GAP_MM
            End If
        End If
    Next vk

    ' Row 1 (continued): prints — each line is order_id|abs_path|count.
    Dim k As Long
    For k = 1 To prints.Count
        Dim tk() As String: tk = Split(prints(k), "|")
        If UBound(tk) >= 2 Then
            Dim p As String: p = tk(1)
            Dim cnt As Long: cnt = 1
            On Error Resume Next
            cnt = CLng(tk(2))
            If Err.Number <> 0 Then cnt = 1
            Err.Clear
            On Error GoTo 0
            If cnt < 1 Then cnt = 1

            Dim ps As Shape: Set ps = Nothing
            Set ps = ImportPrint(doc, p)
            If Not ps Is Nothing Then
                Dim pw As Double: pw = ps.SizeWidth
                Dim ph As Double: ph = ps.SizeHeight
                Dim colY As Double: colY = rowTopY - ph
                ps.SetPosition currentX, colY
                printsCount = printsCount + 1
                Dim dupK As Long
                For dupK = 2 To cnt
                    On Error Resume Next
                    Dim dup As Shape: Set dup = ps.Duplicate(0, 0)
                    If Err.Number = 0 And Not dup Is Nothing Then
                        colY = colY - ph - INTRA_COL_GAP_MM
                        dup.SetPosition currentX, colY
                        printsCount = printsCount + 1
                    End If
                    Err.Clear
                    On Error GoTo 0
                Next dupK
                If colY < lowestY Then lowestY = colY
                currentX = currentX + pw + COL_GAP_MM
            End If
        End If
    Next k

    ' Row 2+: callsign blocks (wrap by page width).
    Dim blockY As Double
    If printsCount > 0 Or vizes.Count > 0 Then
        blockY = lowestY - ROW_GAP_MM
    Else
        blockY = rowTopY
    End If
    Dim curX As Double: curX = PAGE_MARGIN_MM
    Dim rowMaxH As Double: rowMaxH = 0

    Dim ii As Long
    For ii = 1 To lines.Count
        Dim ff() As String: ff = Split(lines(ii), "|")
        ' ff = order_id|index|type|logo|callsign_flag|under_logo|callsigns|quantity
        If UBound(ff) >= 6 Then
            Dim itemLogoFlag As Boolean:  itemLogoFlag = (LCase(ff(3)) = "true")
            Dim itemUnderLogo As Boolean: itemUnderLogo = (LCase(ff(5)) = "true")
            Dim itemCsStr As String:      itemCsStr = ff(6)
            Dim itemPos As String
            itemPos = IIf(itemUnderLogo And itemLogoFlag, "under_logo", "other")
            Dim useLogo As Shape: Set useLogo = Nothing
            If itemUnderLogo And itemLogoFlag Then Set useLogo = logoTemplate

            If Len(itemCsStr) > 0 Then
                Dim csArr() As String: csArr = Split(itemCsStr, ";")
                Dim ci As Long
                For ci = LBound(csArr) To UBound(csArr)
                    Dim cs As String: cs = Trim(csArr(ci))
                    If Len(cs) > 0 Then
                        Dim h As Double
                        h = BuildModernItem(doc, useLogo, cs, itemPos, curX, blockY)
                        If h > rowMaxH Then rowMaxH = h
                        blocksCount = blocksCount + 1
                        curX = curX + BLOCK_STEP_MM
                        If curX + BLOCK_STEP_MM > pageW - PAGE_MARGIN_MM Then
                            curX = PAGE_MARGIN_MM
                            blockY = blockY - rowMaxH - ROW_GAP_MM
                            rowMaxH = 0
                        End If
                    End If
                Next ci
            End If
        End If
    Next ii

    Dim blocksBottom As Double
    If blocksCount > 0 Then
        blocksBottom = blockY - rowMaxH
    Else
        blocksBottom = blockY
    End If
    Dim finalY As Double: finalY = blocksBottom
    If lowestY < finalY Then finalY = lowestY

    RenderOneOrder = Array(finalY, printsCount, blocksCount)
End Function

' ============================================================
' Build one logo+callsign block.
'   callsignPos="under_logo" AND logoTemplate present > logo + callsign below + group
'   otherwise                                          > callsign text only
' Returns block height in mm.
' ============================================================
Private Function BuildModernItem(doc As Document, logoTemplate As Shape, _
    callsign As String, callsignPos As String, topX As Double, topY As Double) As Double

    Dim isUnderLogo As Boolean
    isUnderLogo = (LCase(callsignPos) = "under_logo") And (Not logoTemplate Is Nothing)

    Dim logoShape As Shape
    Set logoShape = Nothing
    Dim logoH As Double, logoW As Double, logoCenterX As Double
    Dim logoY As Double

    If isUnderLogo Then
        On Error Resume Next
        Set logoShape = logoTemplate.Duplicate(0, 0)
        Err.Clear
        On Error GoTo 0
        If Not logoShape Is Nothing Then
            logoW = logoShape.SizeWidth
            logoH = logoShape.SizeHeight
            logoY = topY - logoH
            logoShape.SetPosition topX, logoY
            logoCenterX = topX + logoW / 2
            Call LogToFile(LOG_PATH, "  logo placed at (" & Format(topX, "0") & _
                "," & Format(logoY, "0") & ") size " & Format(logoW, "0") & "x" & _
                Format(logoH, "0") & vbCrLf)
        End If
    End If

    Dim txtShape As Shape
    Set txtShape = Nothing
    Dim txtY As Double, txtX As Double

    On Error Resume Next
    Set txtShape = doc.ActiveLayer.CreateArtisticText(0, 0, callsign)
    Err.Clear
    On Error GoTo 0

    If Not txtShape Is Nothing Then
        On Error Resume Next
        txtShape.Text.Story.Font = CALLSIGN_FONT
        txtShape.Fill.UniformColor.RGBAssign 255, 255, 255
        txtShape.Outline.SetNoOutline
        txtShape.SetSize CALLSIGN_WIDTH_MM, CALLSIGN_HEIGHT_MM
        Err.Clear
        On Error GoTo 0

        If Not logoShape Is Nothing Then
            txtX = logoCenterX - CALLSIGN_WIDTH_MM / 2
            txtY = logoY - LOGO_GAP_MM - CALLSIGN_HEIGHT_MM
        Else
            txtX = topX
            txtY = topY - CALLSIGN_HEIGHT_MM
        End If
        txtShape.SetPosition txtX, txtY
    End If

    ' Group logo + text only when callsign is under_logo
    If isUnderLogo And Not logoShape Is Nothing And Not txtShape Is Nothing Then
        On Error Resume Next
        doc.ClearSelection
        Err.Clear
        logoShape.AddToSelection
        Err.Clear
        txtShape.AddToSelection
        Err.Clear

        Dim grp As Shape: Set grp = Nothing
        Dim asr As ShapeRange: Set asr = doc.ActiveSelectionRange
        If Not asr Is Nothing Then
            If asr.Count >= 2 Then Set grp = asr.Group
        End If
        Err.Clear

        If grp Is Nothing Then
            Dim sr As ShapeRange: Set sr = CreateShapeRange()
            Err.Clear
            If Not sr Is Nothing Then
                sr.Add logoShape
                sr.Add txtShape
                Err.Clear
                Set grp = sr.Group
            End If
            Err.Clear
        End If
        On Error GoTo 0
    End If

    Dim totalH As Double
    totalH = 0
    If Not logoShape Is Nothing Then totalH = totalH + logoH + LOGO_GAP_MM
    If Not txtShape Is Nothing Then totalH = totalH + CALLSIGN_HEIGHT_MM
    BuildModernItem = totalH
End Function

' ============================================================
' Import one print file (CDR/PNG/JPG/TIF/PDF detected by extension).
' Returns the imported Shape (grouped if multi-shape).
' ============================================================
Private Function ImportPrint(doc As Document, filePath As String) As Shape
    On Error Resume Next

    Dim ext As String
    Dim dotPos As Long
    dotPos = InStrRev(filePath, ".")
    If dotPos > 0 Then ext = LCase(Mid(filePath, dotPos + 1))

    ' Pick a CorelDRAW filterId for ImportEx based on extension. For unknown
    ' formats we skip ImportEx entirely and let CorelDRAW auto-detect via Import.
    Dim filterId As Long
    Dim hasFilter As Boolean: hasFilter = True
    Select Case ext
        Case "cdr": filterId = cdrCDR
        Case "png": filterId = cdrPNG
        Case "jpg", "jpeg": filterId = cdrJPEG
        Case "tif", "tiff": filterId = cdrTIFF
        Case "pdf", "ai": filterId = cdrPDF
        Case "eps": filterId = cdrEPS
        Case "svg": filterId = cdrSVG
        Case "bmp": filterId = cdrBMP
        Case "gif": filterId = cdrGIF
        Case "psd": filterId = cdrPSD
        Case Else
            ' Unknown extension (webp, heic, etc.) — try Import without an explicit
            ' filter so CorelDRAW auto-detects. Falls through to the Import-only path below.
            hasFilter = False
    End Select

    Dim impopt As StructImportOptions
    Set impopt = CreateStructImportOptions()
    impopt.Mode = cdrImportFull
    impopt.MaintainLayers = True

    Dim impflt As ImportFilter
    If hasFilter Then
        Set impflt = doc.ActiveLayer.ImportEx(filePath, filterId, impopt)
    End If
    If Not hasFilter Or Err.Number <> 0 Then
        Err.Clear
        doc.ActiveLayer.Import filePath
        If Err.Number <> 0 Then
            Call LogToFile(LOG_PATH, "Print import FAIL " & filePath & ": " & Err.Description & vbCrLf)
            Err.Clear
            Set ImportPrint = Nothing
            Exit Function
        End If
    Else
        If Not impflt Is Nothing Then impflt.Finish
    End If

    Dim s As Shape
    Set s = doc.ActiveShape
    If s Is Nothing Then
        Dim selR As ShapeRange
        Set selR = doc.ActiveSelectionRange
        If selR Is Nothing Then
            Set ImportPrint = Nothing
            Exit Function
        End If
        If selR.Count = 1 Then
            Set s = selR.Shapes(1)
        Else
            Set s = selR.Group()
        End If
    End If

    Set ImportPrint = s
    On Error GoTo 0
End Function

' ============================================================
' Import logo file
' ============================================================
Private Function ImportLogo(doc As Document) As Shape
    On Error Resume Next

    Dim impopt As StructImportOptions
    Set impopt = CreateStructImportOptions()
    impopt.Mode = cdrImportFull
    impopt.MaintainLayers = True

    Dim impflt As ImportFilter
    Set impflt = doc.ActiveLayer.ImportEx(LOGO_PATH, cdrCDR, impopt)
    If Err.Number <> 0 Then
        Err.Clear
        doc.ActiveLayer.Import LOGO_PATH
        If Err.Number <> 0 Then
            Call LogToFile(LOG_PATH, "Logo import FAIL: " & Err.Description & vbCrLf)
            Err.Clear
            Set ImportLogo = Nothing
            Exit Function
        End If
    Else
        If Not impflt Is Nothing Then impflt.Finish
    End If

    Dim s As Shape
    Set s = doc.ActiveShape
    If s Is Nothing Then
        Dim selR As ShapeRange
        Set selR = doc.ActiveSelectionRange
        If selR Is Nothing Then
            Set ImportLogo = Nothing
            Exit Function
        End If
        If selR.Count = 1 Then
            Set s = selR.Shapes(1)
        Else
            Set s = selR.Group()
        End If
    End If

    Set ImportLogo = s
    On Error GoTo 0
End Function

' ============================================================
' Utilities
' ============================================================
Private Function ReadFileUtf8(path As String) As String
    On Error Resume Next
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.CharSet = "utf-8"
    stream.Open
    stream.LoadFromFile path
    If Err.Number <> 0 Then
        ReadFileUtf8 = ""
        Err.Clear
        Exit Function
    End If
    ReadFileUtf8 = stream.ReadText
    stream.Close
    Set stream = Nothing
    On Error GoTo 0
End Function

Private Sub LogToFile(logFilePath As String, message As String)
    On Error Resume Next
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.CharSet = "utf-8"
    stream.Open
    If Dir(logFilePath) <> "" Then
        stream.LoadFromFile logFilePath
        stream.Position = stream.Size
    End If
    Dim ts As String
    ts = Format(Now, "hh:nn:ss") & "." & Format(Int((Timer - Int(Timer)) * 1000), "000")
    stream.WriteText ts & " | " & message
    stream.SaveToFile logFilePath, 2
    stream.Close
    Set stream = Nothing
    On Error GoTo 0
End Sub
