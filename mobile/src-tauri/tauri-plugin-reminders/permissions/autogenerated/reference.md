## Default Permission

Allow the reminder scheduler's commands (schedule, cancel, cancel-all, list-pending), the notification-permission pair they require (permission-status, request-permission), and the Android precise-delivery pair (exact-alarm-status, request-exact-alarm). Each registration carries only an opaque identifier and a local instant — no task text, no note identifier, no vault access, no push service.

#### This default permission set includes the following:

- `allow-schedule`
- `allow-cancel`
- `allow-cancel-all`
- `allow-list-pending`
- `allow-permission-status`
- `allow-request-permission`
- `allow-exact-alarm-status`
- `allow-request-exact-alarm`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`reminders:allow-cancel`

</td>
<td>

Enables the cancel command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:deny-cancel`

</td>
<td>

Denies the cancel command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:allow-cancel-all`

</td>
<td>

Enables the cancel_all command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:deny-cancel-all`

</td>
<td>

Denies the cancel_all command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:allow-exact-alarm-status`

</td>
<td>

Enables the exact_alarm_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:deny-exact-alarm-status`

</td>
<td>

Denies the exact_alarm_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:allow-list-pending`

</td>
<td>

Enables the list_pending command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:deny-list-pending`

</td>
<td>

Denies the list_pending command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:allow-permission-status`

</td>
<td>

Enables the permission_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:deny-permission-status`

</td>
<td>

Denies the permission_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:allow-request-exact-alarm`

</td>
<td>

Enables the request_exact_alarm command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:deny-request-exact-alarm`

</td>
<td>

Denies the request_exact_alarm command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:allow-request-permission`

</td>
<td>

Enables the request_permission command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:deny-request-permission`

</td>
<td>

Denies the request_permission command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:allow-schedule`

</td>
<td>

Enables the schedule command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`reminders:deny-schedule`

</td>
<td>

Denies the schedule command without any pre-configured scope.

</td>
</tr>
</table>
