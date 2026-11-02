#!/usr/bin/env python3
"""CS409 MP3 Phase 4 two-way-reference end-to-end tests (Python stdlib only).

Usage: python3 test_phase4.py [http://localhost:3000]
Uses temporary test users and tasks; cleans up created records afterward.
"""
import json
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000').rstrip('/') + '/api'
TAG = f'phase4-{int(time.time())}-{uuid.uuid4().hex[:7]}'
USERS, TASKS = set(), set()
passed = failed = 0


def request(method, resource, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE + resource, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except urllib.error.URLError as e:
        raise AssertionError(f'Cannot connect to {BASE}: {e.reason}')
    try:
        body = json.loads(raw) if raw else None
    except ValueError:
        raise AssertionError(f'Invalid JSON (HTTP {status}): {raw[:250]!r}')
    if body is not None and (not isinstance(body, dict) or not {'message','data'} <= set(body)):
        raise AssertionError(f'Response must have message and data fields: {body!r}')
    return status, (body['data'] if body else None), body


def expect(method, path, payload=None, status=200):
    actual, data, body = request(method, path, payload)
    expected = {status} if isinstance(status, int) else set(status)
    assert actual in expected, f'{method} {path}: expected {sorted(expected)}, got {actual}: {body}'
    return data


def check(label, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print('PASS:', label)
    except Exception as e:
        failed += 1
        print('FAIL:', label, '—', str(e))


def create_user(name, pending=None):
    body = {'name': name, 'email': f'{uuid.uuid4().hex}@example.org'}
    if pending is not None:
        body['pendingTasks'] = pending
    u = expect('POST', '/users', body, 201)
    assert isinstance(u, dict) and '_id' in u, f'Invalid user data: {u}'
    USERS.add(u['_id'])
    return u


def create_task(name, user=None, completed=False, include_name=True):
    body = {'name': name, 'deadline': '2026-12-01T00:00:00.000Z', 'completed': completed}
    if user is not None:
        body['assignedUser'] = user['_id']
        if include_name:
            body['assignedUserName'] = user['name']
    t = expect('POST', '/tasks', body, 201)
    assert isinstance(t, dict) and '_id' in t, f'Invalid task data: {t}'
    TASKS.add(t['_id'])
    return t


def get_user(u): return expect('GET', '/users/'+u['_id'])
def get_task(t): return expect('GET', '/tasks/'+t['_id'])
def pend(u): return get_user(u)['pendingTasks']
def assignment(t):
    x = get_task(t)
    return x['assignedUser'], x['assignedUserName'], x['completed']

def assert_pending(u, includes=(), excludes=()):
    actual = pend(u)
    for t in includes:
        assert t['_id'] in actual, f'Task {t["_id"]} missing from pendingTasks {actual}'
    for t in excludes:
        assert t['_id'] not in actual, f'Task {t["_id"]} wrongly in pendingTasks {actual}'
    assert len(actual) == len(set(actual)), f'Duplicate pendingTasks: {actual}'


def assert_assigned(t, u=None, completed=None):
    uid, name, is_completed = assignment(t)
    assert uid == (u['_id'] if u else ''), f'wrong assignedUser: {uid}'
    assert name == (u['name'] if u else 'unassigned'), f'wrong assignedUserName: {name}'
    if completed is not None:
        assert is_completed is completed, f'wrong completed: {is_completed}'


def expect_unchanged(method, path, body, status, user_refs=(), task_refs=()):
    before_u = {u['_id']: get_user(u) for u in user_refs}
    before_t = {t['_id']: get_task(t) for t in task_refs}
    expect(method, path, body, status)
    for u in user_refs:
        assert get_user(u) == before_u[u['_id']], 'Rejected request mutated a user'
    for t in task_refs:
        assert get_task(t) == before_t[t['_id']], 'Rejected request mutated a task'


def delete(method_path, kind):
    status, _, raw = request('DELETE', method_path)
    assert status in (200, 204), f'DELETE {method_path}: expected 200/204, got {status}: {raw}'


def run():
    print('Testing:', BASE, '\n')
    a = create_user('Alice-'+TAG)
    b = create_user('Bob-'+TAG)
    c = create_user('Carol-'+TAG)
    print('Created 3 test users.\n')

    t1 = create_task('Pending-'+TAG, a)
    check('POST pending assigned task -> Alice gets pending ID', lambda: (assert_assigned(t1, a, False), assert_pending(a, [t1])))
    t2 = create_task('Completed-'+TAG, a, completed=True)
    check('POST completed assigned task -> Alice does NOT get pending ID', lambda: (assert_assigned(t2, a, True), assert_pending(a, [t1], [t2])))
    t3 = create_task('Unassigned-'+TAG)
    check('POST unassigned task -> default assignment fields', lambda: assert_assigned(t3, None, False))
    t4 = create_task('AutoName-'+TAG, b, include_name=False)
    check('POST assigned task with omitted assignedUserName -> auto-fill', lambda: (assert_assigned(t4,b,False), assert_pending(b,[t4])))

    def bad_post_mismatch():
        body = {'name':'Bad-'+TAG,'deadline':'2026-12-01','assignedUser':b['_id'],'assignedUserName':'Wrong'}
        expect_unchanged('POST','/tasks',body,400,[a,b],[t1,t4])
    check('POST mismatched assignedUserName -> 400, no side effects', bad_post_mismatch)
    check('POST invalid assignedUser ID -> 400', lambda: expect('POST','/tasks',{'name':'Bad','deadline':'2026-12-01','assignedUser':'not-an-id'},400))
    missing_id = '507f1f77bcf86cd799439099'
    check('POST nonexistent assignedUser -> 404', lambda: expect('POST','/tasks',{'name':'Bad','deadline':'2026-12-01','assignedUser':missing_id},404))

    def edit_task(t, user=None, completed=False, name=None, add_name=True):
        body={'name':name or t['name'], 'deadline':'2026-12-01T00:00:00.000Z', 'completed':completed}
        if user:
            body['assignedUser']=user['_id']
            if add_name: body['assignedUserName']=user['name']
        return expect('PUT','/tasks/'+t['_id'],body,200)

    def do_transfer():
        edit_task(t1,b)
        assert_assigned(t1,b,False)
        assert_pending(a,excludes=[t1])
        assert_pending(b,includes=[t1,t4])
    check('PUT task transfer Alice -> Bob removes/adds pending ID',do_transfer)
    def do_complete():
        edit_task(t1,b,True)
        assert_assigned(t1,b,True)
        assert_pending(b,excludes=[t1])
    check('PUT task completed -> no pending ID, retains assignment',do_complete)
    def do_reopen():
        edit_task(t1,b,False)
        assert_assigned(t1,b,False)
        assert_pending(b,includes=[t1])
    check('PUT task reopened -> pending ID restored',do_reopen)
    def do_unassign():
        edit_task(t1)
        assert_assigned(t1,None,False)
        assert_pending(b,excludes=[t1])
    check('PUT task unassigned -> clears fields and old pending ID',do_unassign)
    def do_completed_transfer():
        edit_task(t2,c,True)
        assert_assigned(t2,c,True)
        assert_pending(a,excludes=[t2])
        assert_pending(c,excludes=[t2])
    check('PUT already-completed task to different user -> assigned but not pending',do_completed_transfer)
    def do_bad_put():
        body={'name':'Bad','deadline':'2026-12-01','assignedUser':b['_id'],'assignedUserName':'Wrong'}
        expect_unchanged('PUT','/tasks/'+t4['_id'],body,400,[a,b],[t4])
    check('PUT task mismatched assignedUserName -> 400, unchanged',do_bad_put)

    def put_user(u, name, pending=None):
        body={'name':name,'email':get_user(u)['email']}
        if pending is not None: body['pendingTasks']=pending
        return expect('PUT','/users/'+u['_id'],body,200)

    def do_user_attach():
        put_user(a,a['name'],[t3['_id']])
        assert_assigned(t3,a,False)
        assert_pending(a,includes=[t3])
    check('PUT user adds pending task -> assigns task',do_user_attach)
    def do_user_transfer():
        put_user(c,c['name'],[t3['_id']])
        assert_assigned(t3,c,False)
        assert_pending(a,excludes=[t3])
        assert_pending(c,includes=[t3])
    check('PUT user claims another user’s pending task -> transfers it',do_user_transfer)
    def do_rename():
        new_name='CarolRenamed-'+TAG
        put_user(c,new_name,[t3['_id']]); c['name']=new_name
        assert_assigned(t3,c,False)
        assert_assigned(t2,c,True) # completed assigned task also renamed
        assert_pending(c,includes=[t3],excludes=[t2])
    check('PUT user rename updates pending AND completed assigned task names',do_rename)
    def do_user_remove():
        put_user(c,c['name'],[])  # explicit empty list
        assert_assigned(t3,None,False)
        assert_assigned(t2,c,True) # completed assignment remains
        assert_pending(c,excludes=[t3,t2])
    check('PUT user removes pending -> unassigns task, keeps completed assignment',do_user_remove)
    def do_user_omit():
        put_user(b,b['name'])  # missing pendingTasks behaves as empty list
        assert_assigned(t4,None,False)
        assert_pending(b,excludes=[t4])
    check('PUT user omitted pendingTasks -> empty list, previous pending unassigned',do_user_omit)
    def do_invalid_user_pending():
        expect_unchanged('PUT','/users/'+a['_id'],{'name':a['name'],'email':get_user(a)['email'],'pendingTasks':['xyz']},400,[a,c],[t2,t3])
    check('PUT user invalid task ID -> 400, unchanged',do_invalid_user_pending)
    def do_missing_user_pending():
        expect_unchanged('PUT','/users/'+a['_id'],{'name':a['name'],'email':get_user(a)['email'],'pendingTasks':[missing_id]},404,[a],[t3])
    check('PUT user nonexistent task ID -> 404, unchanged',do_missing_user_pending)
    def do_completed_in_pending():
        expect_unchanged('PUT','/users/'+a['_id'],{'name':a['name'],'email':get_user(a)['email'],'pendingTasks':[t2['_id']]},400,[a,c],[t2])
    check('PUT user completed task in pendingTasks -> 400, unchanged',do_completed_in_pending)

    def do_post_user_with_pending():
        u = create_user('Dave-'+TAG,[t3['_id']])
        assert_assigned(t3,u,False)
        assert_pending(u,includes=[t3])
    check('POST user with pendingTasks -> assigns existing task',do_post_user_with_pending)
    def do_post_user_claim_transfer():
        u = create_user('Eve-'+TAG,[t3['_id']])
        assert_assigned(t3,u,False)
        for other_id in USERS - {u['_id']}:
            assert t3['_id'] not in expect('GET','/users/'+other_id)['pendingTasks']
    check('POST new user claims task from another -> previous user loses it',do_post_user_claim_transfer)
    def bad_post_user_completed():
        expect('POST','/users',{'name':'Bad','email':uuid.uuid4().hex+'@example.org','pendingTasks':[t2['_id']]},400)
        assert_assigned(t2,c,True)
    check('POST user with completed pending task -> 400',bad_post_user_completed)
    def bad_post_user_missing():
        expect('POST','/users',{'name':'Bad','email':uuid.uuid4().hex+'@example.org','pendingTasks':[missing_id]},404)
    check('POST user with nonexistent pending task -> 404',bad_post_user_missing)

    def delete_task_case():
        fresh=create_task('DeleteMe-'+TAG,a)
        assert_pending(a,includes=[fresh])
        delete('/tasks/'+fresh['_id'],'task'); TASKS.discard(fresh['_id'])
        assert_pending(a,excludes=[fresh])
        expect('GET','/tasks/'+fresh['_id'],status=404)
    check('DELETE pending task removes user reference and task',delete_task_case)
    def delete_user_case():
        u=create_user('DeleteOwner-'+TAG)
        pending=create_task('DeletePending-'+TAG,u)
        completed=create_task('DeleteCompleted-'+TAG,u,True)
        delete('/users/'+u['_id'],'user'); USERS.discard(u['_id'])
        expect('GET','/users/'+u['_id'],status=404)
        assert_assigned(pending,None,False)
        assert_assigned(completed,None,True)
    check('DELETE user unassigns both pending and completed tasks',delete_user_case)


def cleanup():
    print('\nCleaning up test data...')
    for tid in list(TASKS):
        try:
            status,_,_=request('DELETE','/tasks/'+tid)
            if status in (200,204,404): TASKS.discard(tid)
        except Exception: pass
    for uid in list(USERS):
        try:
            status,_,_=request('DELETE','/users/'+uid)
            if status in (200,204,404): USERS.discard(uid)
        except Exception: pass
    if USERS or TASKS:
        print(f'WARNING: cleanup incomplete: {len(USERS)} users, {len(TASKS)} tasks may remain. Tag: {TAG}')


if __name__ == '__main__':
    try:
        run()
    except Exception as e:
        failed += 1
        print('SETUP OR UNEXPECTED ERROR:',e)
    finally:
        cleanup()
    print(f'\nRESULT: {passed} PASSED, {failed} FAILED')
    sys.exit(1 if failed else 0)
