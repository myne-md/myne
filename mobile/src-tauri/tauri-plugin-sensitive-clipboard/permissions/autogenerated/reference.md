## Default Permission

Allow the mobile clipboard commands: the two WRITE arms (ordinary text, and secrets the OS is asked to confine and expire), and the user-initiated READ that backs the recovery-phrase Paste.

#### This default permission set includes the following:

- `allow-write-text`
- `allow-write-secret`
- `allow-read-text`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`sensitive-clipboard:allow-read-text`

</td>
<td>

Enables the read_text command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sensitive-clipboard:deny-read-text`

</td>
<td>

Denies the read_text command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sensitive-clipboard:allow-write-secret`

</td>
<td>

Enables the write_secret command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sensitive-clipboard:deny-write-secret`

</td>
<td>

Denies the write_secret command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sensitive-clipboard:allow-write-text`

</td>
<td>

Enables the write_text command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`sensitive-clipboard:deny-write-text`

</td>
<td>

Denies the write_text command without any pre-configured scope.

</td>
</tr>
</table>
