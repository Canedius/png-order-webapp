VERSION 5.00
Begin {C62A69F0-16DC-11CE-9E98-00AA00574A4F} PngOrderForm 
   Caption         =   " PNG Modern"
   ClientHeight    =   2760
   ClientLeft      =   45
   ClientTop       =   390
   ClientWidth     =   5505
   OleObjectBlob   =   "PngOrderForm.frx":0000
   StartUpPosition =   1  'CenterOwner
End
Attribute VB_Name = "PngOrderForm"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False
Option Explicit

Private Sub UserForm_Initialize()
    txtOrderId.SetFocus
End Sub

' Shared launcher used by Enter in the text box and (optionally) by btnRun.
Private Sub RunCurrent()
    Dim id As String
    id = Trim(txtOrderId.Text)
    If Len(id) = 0 Then
        MsgBox "Enter order number.", vbExclamation, "PNG Order"
        txtOrderId.SetFocus
        Exit Sub
    End If
    If Not IsNumeric(id) Then
        MsgBox "Order number must be numeric.", vbExclamation, "PNG Order"
        txtOrderId.SetFocus
        Exit Sub
    End If
    Me.Hide
    Call PngOrderAuto.RunForOrder(id)
    Unload Me
End Sub

' Optional Run button — only needed if you added a CommandButton named btnRun.
Private Sub btnRun_Click()
    Call RunCurrent
End Sub

Private Sub btnToday_Click()
    Me.Hide
    Call PngOrderAuto.RunForToday
    Unload Me
End Sub

Private Sub btnAll_Click()
    Me.Hide
    Call PngOrderAuto.RunForAll
    Unload Me
End Sub

' Enter key in the text box runs the same launcher (no button needed).
Private Sub txtOrderId_KeyDown(ByVal KeyCode As MSForms.ReturnInteger, ByVal Shift As Integer)
    If KeyCode = 13 Then
        KeyCode = 0
        Call RunCurrent
    End If
End Sub
